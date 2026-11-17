import { z } from "zod";
import type { EventBus } from "./event-bus.js";
import type { JobEventChannel, JobOutcome } from "./jobEvents/index.js";
import { createLimiter, type Release } from "./concurrency.js";
import type { GraphAppContext } from "./graph/appContext.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import { RunModeSchema } from "@/core/graph/shared/domain/RunMode.js";
import type {
  CaseGenerationRequest,
  FirstCallRequest,
  Regenerate,
} from "@/api/index.js";
import { InvalidPathError, rerollAll, type CasePiece } from "./regenerate.js";
import { getRequestContext, runWithContext } from "./graph/utils/context.js";
import { AppError, OutlineNotAcceptedError } from "./graph/errors/AppError.js";
import {
  checkSkeleton,
  outlineSections,
  withHeading,
  restoreSkeletonHeadings,
  OutlineSegmentsSchema,
  type OutlineSegments,
} from "@/core/graph/shared/outline/segments.js";
import { localizeHeadings } from "./graph/03-outline-translation/headings.js";
import type { IcdPort } from "./diagnosis/icd.js";
import { resolveDiagnosis } from "./diagnosis/resolve.js";
import {
  decodeContext,
  encodeContext,
  caseUnits,
  partSources,
  type GenerationContext,
} from "./generationContext.js";

export type CaseGenerationResultError = {
  code: string;
  message: string;
  details?: string;
  /** HTTP status a REST transport should report; ignored by NATS. */
  statusCode?: number;
};

/**
 * Outline as positional segment array. Plan-mode plan: request language;
 * normal-mode plan (handed over on the way to the case): English.
 */
export const PlanPayloadSchema = z.object({
  jobId: z.string(),
  status: z
    .literal("planned")
    .optional()
    .describe(
      "Set on a terminal plan; absent on a normal-mode plan on the way."
    ),
  mode: RunModeSchema,
  language: z.string(),
  plan: OutlineSegmentsSchema,
  context: z
    .string()
    .optional()
    .describe(
      "Opaque generation context (#272), on a plan-mode stop: send it back, " +
        "with the possibly edited `plan`, to generate the case. Absent on a " +
        "normal-mode plan: its case response carries the context."
    ),
});

export type PlanPayload = z.infer<typeof PlanPayloadSchema>;

/** Wire payload of a `planned` result: SSE `event: plan`, NATS `cases.plan.<jobId>`. */
export function planPayloadOf(result: CaseGenerationResult): PlanPayload {
  return {
    jobId: result.jobId,
    status: "planned",
    mode: "plan",
    language: result.language!,
    plan: result.plan!,
    context: result.context!,
  };
}

export type CaseGenerationResult = {
  jobId: string;
  /** `planned`: plan-mode first call stops here. */
  status: "done" | "planned" | "failed";
  case?: Case;
  /** Regenerated pieces of an existing case, instead of `case` (#272). */
  pieces?: CasePiece[];
  plan?: OutlineSegments;
  /**
   * Language generation ran in (echoes `req.language`, default `en`).
   * Set on success and plan stop.
   */
  language?: Language;
  /** Encoded {@link GenerationContext}; set on `done` and `planned`. */
  context?: string;
  error?: CaseGenerationResultError;
};

/**
 * Accepted (channel already open; `result` settles when call ends) or
 * rejected up front as duplicate jobId (409).
 */
export type StartedJob =
  | { accepted: true; jobId: string; result: Promise<CaseGenerationResult> }
  | { accepted: false; jobId: string; result: CaseGenerationResult };

export type StartOptions = {
  /** A generation slot the caller already holds (the NATS worker). */
  slot?: Release;
  /**
   * Called with a normal-mode job's plan once it exists, mid-generation.
   * Plan-mode plan is the result instead. Must not throw.
   */
  onPlan?: (plan: PlanPayload) => void;
};

/**
 * Single seam both transports call through. Owns diagnosis resolution, jobId
 * minting, `runWithContext`, terminal event emission, error→status mapping,
 * and each job's open/close on the per-job event channel.
 *
 * Stateless between calls: request (plus optional plan) carries everything;
 * nothing survives. No plan: produce one (plan mode stops, normal mode goes
 * on to case). With plan: skip planning, generate case. Crash recovery is
 * transport's job.
 */
export interface CaseGenerationService {
  /**
   * Reserve jobId, open channel, start job, all synchronously. Caller can
   * subscribe before any node runs and learns of a duplicate up front.
   */
  start(req: CaseGenerationRequest, opts?: StartOptions): StartedJob;
  /** {@link start}, awaited. */
  generate(
    req: CaseGenerationRequest,
    opts?: StartOptions
  ): Promise<CaseGenerationResult>;
  /** Wait for a free generation slot, to pass to {@link generate}. */
  reserveSlot(): Promise<Release>;
  /** Abort a running or queued job. `false` if this process has no such job. */
  cancel(jobId: string): boolean;
}

export const DEFAULT_MAX_CONCURRENT_GENERATIONS = 4;

/** Map a finished job's result onto the channel's terminal marker. */
function outcomeOf(result: CaseGenerationResult): JobOutcome {
  if (result.status === "done") return { status: "done" };
  if (result.status === "planned") return { status: "planned" };
  if (result.error?.code === "GENERATION_CANCELLED") {
    return { status: "cancelled" };
  }
  return {
    status: "failed",
    error: {
      code: result.error?.code ?? "GENERATION_FAILED",
      message: result.error?.message ?? "Generation failed",
    },
  };
}

function failure(
  jobId: string,
  code: string,
  message: string,
  statusCode: number,
  details?: string
): CaseGenerationResult {
  return {
    jobId,
    status: "failed",
    error: {
      code,
      message,
      statusCode,
      ...(details !== undefined && { details }),
    },
  };
}

/** A plan handed back that cannot be generated from. */
class InvalidPlanError extends AppError {
  constructor(message: string) {
    super(message, "INVALID_PLAN", 400);
  }
}

export function createCaseGenerationService(
  graph: GraphAppContext,
  bus: EventBus,
  jobEvents: JobEventChannel,
  opts: {
    /** Bounds generations across every transport. */
    maxConcurrent?: number;
    /** WHO ICD-11 API; absent = no ICD configured (`resolveDiagnosis`). */
    icd?: IcdPort;
  } = {}
): CaseGenerationService {
  const limiter = createLimiter(
    opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_GENERATIONS
  );
  const sandwich = graph.config.TRANSLATION_SANDWICH;
  // One per job from submission, so queued jobs are cancellable.
  const controllers = new Map<string, AbortController>();

  // ─── the plan's round trip ────────────────────────────────────────────────

  /**
   * Plan for display. Server-owned headings come from the catalogues, never
   * from a free translation; the body is translated out under the sandwich,
   * and already in `language` without it.
   */
  async function localizePlan(
    outline: OutlineSegments,
    language: Language
  ): Promise<OutlineSegments> {
    const headings = await localizeHeadings(
      graph.runtime,
      outline,
      language,
      getRequestContext()
    );
    return sandwich
      ? translatePlanOut(outline, headings)
      : outline.map((segment, i) => ({
          fixed: segment.fixed,
          text: headings.has(i)
            ? withHeading(headings.get(i)!, segment.text)
            : segment.text,
        }));
  }

  async function translatePlanOut(
    english: OutlineSegments,
    headings: Map<number, string>
  ): Promise<OutlineSegments> {
    // A localized heading carries its body (frozen General, #221): the
    // dictionary owns the heading line, the translator only the body.
    const bodyOf = (text: string) => text.slice(text.indexOf("\n") + 1).trim();
    const translated = await graph.translateOutline!(
      Object.fromEntries(
        english.flatMap((segment, i) => {
          if (!headings.has(i)) return [[String(i), segment.text]];
          const body = segment.text.includes("\n") ? bodyOf(segment.text) : "";
          return body ? [[String(i), body]] : [];
        })
      ),
      "out"
    );
    return english.map((segment, i) => {
      const heading = headings.get(i);
      const text =
        heading === undefined
          ? (translated[String(i)] ?? segment.text)
          : translated[String(i)]
            ? `${heading}\n\n${translated[String(i)]}`
            : heading;
      return { fixed: segment.fixed, text };
    });
  }

  /**
   * Handed-in plan in the context's working language, or
   * {@link InvalidPlanError}. A segment equal to what the reviewer was shown
   * (`context.localized`) is untouched and comes from `context.plan`; only
   * edited ones are translated in (sandwich). Fixed headings are server-owned,
   * restored by position, not trusted from a translation.
   */
  async function workingPlanOf(
    plan: OutlineSegments,
    context: GenerationContext
  ): Promise<OutlineSegments> {
    const anamnesisCategories = graph.runtime.catalogs.anamnesis.list();
    const shown = context.localized;
    let working = plan;
    if (shown) {
      const untouched = (i: number) => plan[i]!.text === shown[String(i)];
      const misses = plan.flatMap((segment, i) =>
        !untouched(i) && segment.text.trim() !== "" ? [i] : []
      );
      const translated =
        sandwich && misses.length > 0
          ? await graph.translateOutline!(
              Object.fromEntries(misses.map((i) => [String(i), plan[i]!.text])),
              "in"
            )
          : {};
      working = restoreSkeletonHeadings(
        plan.map((segment, i) => ({
          fixed: segment.fixed,
          text: untouched(i)
            ? (context.plan[i]?.text ?? segment.text)
            : (translated[String(i)] ?? segment.text),
        })),
        { anamnesisCategories }
      );
    }
    const skeleton = checkSkeleton(working, { anamnesisCategories });
    if (!skeleton.ok) throw new InvalidPlanError(skeleton.message);
    return working;
  }

  // ─── one call ─────────────────────────────────────────────────────────────

  async function run(
    req: CaseGenerationRequest,
    jobId: string,
    startOpts: StartOptions,
    signal: AbortSignal
  ): Promise<CaseGenerationResult> {
    const language = req.language;

    return runWithContext(
      async (): Promise<CaseGenerationResult> => {
        const continuation = "context" in req && req.context ? req : undefined;
        const first = continuation
          ? { context: decodeContext(continuation.context) }
          : await firstPlan(req as FirstCallRequest, language);
        if ("status" in first) return first;
        const { context } = first;

        if (continuation?.regenerate) {
          return regenerate(context, continuation.regenerate);
        }

        const plan = continuation?.plan
          ? await workingPlanOf(continuation.plan, context)
          : context.plan;
        const generatedCase = await graph.renderCase({
          diagnosis: context.diagnosis,
          generationFlags: context.generationFlags,
          difficulty: req.difficulty ?? context.difficulty,
          // Each case node reads only its own sections (#215).
          outlineSections: outlineSections(plan),
        });
        return {
          jobId,
          status: "done",
          case: generatedCase,
          language,
          context: encodeContext({
            ...context,
            localized: undefined,
            plan,
            fields: context.generationFlags,
            ...partSources(caseUnits(generatedCase)),
          }),
        };
      },
      jobId,
      req.llmConfig,
      language,
      signal
    );

    /**
     * First call: resolve the diagnosis, plan. Plan mode stops with the
     * (localized) plan; normal mode hands the plan over and returns the
     * context to render from.
     */
    async function firstPlan(
      req: FirstCallRequest,
      language: Language
    ): Promise<{ context: GenerationContext } | CaseGenerationResult> {
      // Before the graph: English name (+ code with ICD), or a 400/503 (#237).
      const diagnosis = await resolveDiagnosis(
        { icd: opts.icd, runtime: graph.runtime },
        { icd: req.icd, name: req.diagnosis },
        language
      );
      const planned = await graph.planCase({
        diagnosis,
        generationFlags: req.generationFlags,
        userInstructions: req.userInstructions,
        language,
        difficulty: req.difficulty,
        mode: req.mode,
      });
      const context: GenerationContext = {
        v: 1,
        diagnosis: planned.diagnosis,
        ...(req.difficulty && { difficulty: req.difficulty }),
        generationFlags: req.generationFlags,
        ...(req.userInstructions && { userInstructions: req.userInstructions }),
        fields: [],
        plan: planned.outlineSegments,
        parts: {},
        units: {},
      };

      // Shown even if judge never accepted; reviewer judges.
      if (req.mode === "plan") return planStop(context);
      // Never render an unaccepted outline.
      if (!planned.outlineAccepted) throw new OutlineNotAcceptedError();
      startOpts.onPlan?.({
        jobId,
        mode: "normal",
        language,
        plan: context.plan,
      });
      return { context };
    }

    /** Plan-mode stop: the plan for review, localized when not English. */
    async function planStop(
      context: GenerationContext
    ): Promise<CaseGenerationResult> {
      const shown =
        language === "en"
          ? undefined
          : await localizePlan(context.plan, language);
      return {
        jobId,
        status: "planned",
        plan: shown ?? context.plan,
        language,
        context: encodeContext({
          ...context,
          localized: shown
            ? Object.fromEntries(shown.map((s, i) => [String(i), s.text]))
            : undefined,
        }),
      };
    }

    /**
     * Regenerate entries (#272). Whole-outline reroll: plan again from the
     * first call's inputs (new recipe roll), back to plan review. Otherwise
     * every entry rerolls concurrently into a piece.
     */
    async function regenerate(
      context: GenerationContext,
      entries: Regenerate[]
    ): Promise<CaseGenerationResult> {
      // ponytail: refine lands with the refiner; reroll only until then.
      if (
        entries.some(
          (e) =>
            e.instruction !== undefined ||
            (e.path.length > 1 && e.path[0] === "outline")
        )
      )
        throw new AppError(
          "Refining is not implemented yet",
          "NOT_IMPLEMENTED",
          501
        );
      const outline = entries.filter((e) => e.path[0] === "outline");
      if (outline.length > 0) {
        if (entries.length > 1)
          throw new InvalidPathError(
            ["outline"],
            "an outline entry must be the only one"
          );
        const planned = await graph.planCase({
          diagnosis: context.diagnosis,
          generationFlags: context.generationFlags,
          userInstructions: context.userInstructions,
          language,
          difficulty: req.difficulty ?? context.difficulty,
          mode: "plan",
        });
        return planStop({ ...context, plan: planned.outlineSegments });
      }
      const done = await rerollAll(
        graph,
        context,
        entries,
        req.difficulty ?? context.difficulty
      );
      return {
        jobId,
        status: "done",
        pieces: done.pieces,
        language,
        context: encodeContext({ ...done.context, localized: undefined }),
      };
    }
  }

  function errorResult(jobId: string, error: unknown): CaseGenerationResult {
    console.error(error);

    if (error instanceof Error && error.name === "AbortError") {
      bus.emit("Generation Cancelled", { jobId });
      return failure(
        jobId,
        "GENERATION_CANCELLED",
        "Generation was cancelled",
        499
      );
    }
    if (error instanceof Error) {
      bus.emit("Generation Failure", { error, jobId });
    }
    if (error instanceof AppError) {
      return failure(
        jobId,
        error.code,
        error.message,
        error.statusCode,
        error.details
      );
    }
    return failure(
      jobId,
      "GENERATION_FAILED",
      "Internal server error",
      500,
      error instanceof Error ? error.message : String(error)
    );
  }

  function start(
    req: CaseGenerationRequest,
    startOpts: StartOptions = {}
  ): StartedJob {
    const jobId = req.jobId ?? crypto.randomUUID();

    // jobId is idempotency key: duplicate never starts a second generation.
    // Only reuse allowed: call following a plan stop, carrying the plan.
    if (!jobEvents.open(jobId)) {
      startOpts.slot?.();
      const active = jobEvents.state(jobId) === "active";
      return {
        accepted: false,
        jobId,
        result: failure(
          jobId,
          active ? "JOB_ALREADY_ACTIVE" : "JOB_ALREADY_COMPLETED",
          active
            ? "A generation with this jobId is already running"
            : "A generation with this jobId has already finished",
          409
        ),
      };
    }

    const controller = new AbortController();
    controllers.set(jobId, controller);

    const result = (async (): Promise<CaseGenerationResult> => {
      let release = startOpts.slot;
      let finished: CaseGenerationResult;
      try {
        // Inside `try` so cancel while queued maps to `GENERATION_CANCELLED`.
        release ??= await limiter.acquire(controller.signal);
        finished = await run(req, jobId, startOpts, controller.signal);
        if (finished.status === "done") {
          bus.emit("Generation Completed", { case: finished.case!, jobId });
        }
      } catch (error) {
        finished = errorResult(jobId, error);
      } finally {
        release?.();
        controllers.delete(jobId);
      }
      jobEvents.close(jobId, outcomeOf(finished));
      return finished;
    })();

    return { accepted: true, jobId, result };
  }

  return {
    start,

    async generate(req, startOpts = {}): Promise<CaseGenerationResult> {
      return start(req, startOpts).result;
    },

    reserveSlot() {
      return limiter.acquire();
    },

    cancel(jobId: string): boolean {
      const controller = controllers.get(jobId);
      if (!controller || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
  };
}
