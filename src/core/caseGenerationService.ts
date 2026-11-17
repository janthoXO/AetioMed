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
import {
  InvalidPathError,
  isRefine,
  refineRequest,
  rerollAll,
  type CasePiece,
  ProposalSchema,
  type Proposal,
} from "./regenerate.js";
import type { GenerationFlag } from "@/core/graph/shared/domain/GenerationFlags.js";
import { getRequestContext, runWithContext } from "./graph/utils/context.js";
import { AppError, OutlineNotAcceptedError } from "./graph/errors/AppError.js";
import {
  checkSkeleton,
  outlineSections,
  withHeading,
  restoreSkeletonHeadings,
  sectionHeadings,
  fieldOfSection,
  OutlineSegmentsSchema,
  type OutlineSegments,
} from "@/core/graph/shared/outline/segments.js";
import { applySections } from "./graph/refine.js";
import { localizeHeadings } from "./graph/03-outline-translation/headings.js";
import type { IcdPort } from "./diagnosis/icd.js";
import { resolveDiagnosis } from "./diagnosis/resolve.js";
import {
  decodeContext,
  encodeContext,
  caseUnits,
  partSources,
  withSources,
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
const PlanBodySchema = z.object({
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
  changed: z
    .array(z.number().int())
    .optional()
    .describe(
      "After a refine in plan review: heading segment indices of the sections that changed."
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Opaque generation context (#272), on a plan-mode stop: send it back, " +
        "with the possibly edited `plan`, to generate the case. Absent on a " +
        "normal-mode plan: its case response carries the context."
    ),
});

/** Outline-level refine of an existing case (#272): nothing rendered yet. */
const ProposalBodySchema = z.object({
  jobId: z.string(),
  status: z.literal("planned"),
  language: z.string(),
  proposal: ProposalSchema,
  context: z
    .string()
    .describe(
      "Opaque generation context; send it back with `accept` to apply the proposal."
    ),
});

/** `event: plan` / `cases.plan.<jobId>`: a plan, or a case's proposal. */
export const PlanPayloadSchema = z.union([PlanBodySchema, ProposalBodySchema]);

export type PlanPayload = z.infer<typeof PlanPayloadSchema>;

/** Wire payload of a `planned` result: SSE `event: plan`, NATS `cases.plan.<jobId>`. */
export function planPayloadOf(result: CaseGenerationResult): PlanPayload {
  const { jobId, language, context } = result;
  if (result.proposal) {
    return {
      jobId,
      status: "planned",
      language: language!,
      proposal: result.proposal,
      context: context!,
    };
  }
  return {
    jobId,
    status: "planned",
    mode: "plan",
    language: language!,
    plan: result.plan!,
    ...(result.changed && { changed: result.changed }),
    context: context!,
  };
}

export type CaseGenerationResult = {
  jobId: string;
  /** `planned`: plan-mode first call stops here. */
  status: "done" | "planned" | "failed";
  case?: Case;
  /** Regenerated pieces of an existing case, instead of `case` (#272). */
  pieces?: CasePiece[];
  /** Plan review: heading indices of the sections a refine changed. */
  changed?: number[];
  /** Outline-level refine of a case: what `accept` would regenerate. */
  proposal?: Proposal;
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
  onPlan?: (plan: z.infer<typeof PlanBodySchema>) => void;
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
    language: Language,
    /** Earlier context: a segment unchanged since keeps its shown text. */
    previous?: GenerationContext
  ): Promise<OutlineSegments> {
    const headings = await localizeHeadings(
      graph.runtime,
      outline,
      language,
      getRequestContext()
    );
    return sandwich
      ? translatePlanOut(outline, headings, previous)
      : outline.map((segment, i) => ({
          fixed: segment.fixed,
          text: headings.has(i)
            ? withHeading(headings.get(i)!, segment.text)
            : segment.text,
        }));
  }

  async function translatePlanOut(
    english: OutlineSegments,
    headings: Map<number, string>,
    previous?: GenerationContext
  ): Promise<OutlineSegments> {
    const kept = (i: number) =>
      previous?.plan[i]?.text === english[i]!.text
        ? previous.localized?.[String(i)]
        : undefined;
    // A localized heading carries its body (frozen General, #221): the
    // dictionary owns the heading line, the translator only the body.
    const bodyOf = (text: string) => text.slice(text.indexOf("\n") + 1).trim();
    const translated = await graph.translateOutline!(
      Object.fromEntries(
        english.flatMap((segment, i) => {
          if (kept(i) !== undefined) return [];
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
        kept(i) ??
        (heading === undefined
          ? (translated[String(i)] ?? segment.text)
          : translated[String(i)]
            ? `${heading}\n\n${translated[String(i)]}`
            : heading);
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
        if (continuation?.accept) return accept(context, continuation.accept);

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
        // Plan-mode outline is written in the request language without the sandwich.
        planLanguage: req.mode === "plan" && !sandwich ? language : "en",
        recipe: planned.recipe,
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
      context: GenerationContext,
      revised?: { previous: GenerationContext; changed: number[] }
    ): Promise<CaseGenerationResult> {
      const shown =
        language === "en"
          ? undefined
          : await localizePlan(context.plan, language, revised?.previous);
      return {
        jobId,
        status: "planned",
        plan: shown ?? context.plan,
        ...(revised && { changed: revised.changed }),
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
      const refines = entries.filter(isRefine);
      if (refines.length > 0) return refine(context, refines, entries);
      if (entries.some((e) => e.path[0] === "outline")) {
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
        return planStop({
          ...context,
          plan: planned.outlineSegments,
          planLanguage: sandwich ? "en" : language,
          recipe: planned.recipe,
        });
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

    /**
     * Refine entries (#272): the refiner picks each one's level. Any at
     * outline level makes the call one outline change, nothing rendered:
     * plan review gets the revised plan, a case gets a proposal.
     */
    async function refine(
      context: GenerationContext,
      refines: Regenerate[],
      entries: Regenerate[]
    ): Promise<CaseGenerationResult> {
      if (refines.length < entries.length)
        throw new InvalidPathError(
          refines[0]!.path,
          "refine entries cannot be mixed with rerolls"
        );
      const facts = {
        plan: context.plan,
        planLanguage: context.planLanguage,
        diagnosis: context.diagnosis,
        difficulty: req.difficulty ?? context.difficulty ?? "medium",
        recipe: context.recipe,
      };
      const refinements = await Promise.all(
        refines.map((entry) =>
          graph.refiner.refine(facts, refineRequest(context, entry))
        )
      );
      const outline = refinements.filter((r) => r.level === "outline");
      if (outline.length === 0) {
        // ponytail: plan and render levels land with the unit planner.
        throw new AppError(
          "Refining below the outline is not implemented yet",
          "NOT_IMPLEMENTED",
          501
        );
      }
      const settled = await graph.refiner.settle(
        facts,
        new Map(outline.flatMap((r) => [...r.sections]))
      );
      const changed = [...settled.sections.keys()].sort((a, b) => a - b);
      if (context.fields.length === 0) {
        return planStop(
          { ...context, plan: settled.plan },
          { previous: context, changed }
        );
      }
      const proposal = await proposalOf(
        context,
        settled.sections,
        outline.flatMap((r) => r.affected),
        outline.map((r) => r.why).join(" ")
      );
      return {
        jobId,
        status: "planned",
        proposal,
        language,
        context: encodeContext({
          ...context,
          localized: undefined,
          proposal: {
            sections: Object.fromEntries(
              [...settled.sections].map(([i, body]) => [String(i), body])
            ),
          },
        }),
      };
    }

    /**
     * Apply a pending proposal: new sections for the accepted fields and
     * the background, old ones for the rest; the accepted fields are
     * regenerated from the composed plan.
     */
    async function accept(
      context: GenerationContext,
      fields: GenerationFlag[]
    ): Promise<CaseGenerationResult> {
      if (!context.proposal)
        throw new AppError("No pending proposal to accept", "NO_PROPOSAL", 400);
      const heading = new Map(
        sectionHeadings(context.plan).map((h) => [h.index, h.heading])
      );
      const taken = new Map(
        Object.entries(context.proposal.sections)
          .map(([i, body]) => [Number(i), body] as const)
          .filter(([i]) => {
            const field = fieldOfSection(heading.get(i) ?? "");
            return (
              !field ||
              !context.fields.includes(field) ||
              fields.includes(field)
            );
          })
      );
      const plan = applySections(context.plan, taken);
      const c = await graph.renderCase({
        diagnosis: context.diagnosis,
        generationFlags: fields,
        difficulty: req.difficulty ?? context.difficulty,
        outlineSections: outlineSections(plan),
      });
      const pieces: CasePiece[] = fields.flatMap((field) =>
        c[field] === undefined
          ? []
          : [{ path: [field], how: "refined" as const, value: c[field] }]
      );
      const next = fields.reduce<GenerationContext>(
        (ctx, field) =>
          withSources(ctx, [field], caseUnits({ [field]: c[field] })),
        {
          ...context,
          plan,
          proposal: undefined,
          localized: undefined,
          fields: [...new Set([...context.fields, ...fields])],
        }
      );
      return {
        jobId,
        status: "done",
        pieces,
        language,
        context: encodeContext(next),
      };
    }

    /** Changed sections mapped to case fields; the rest is background. */
    async function proposalOf(
      context: GenerationContext,
      sections: Map<number, string>,
      affected: { index: number; why: string }[],
      fallback: string
    ): Promise<Proposal> {
      const heading = new Map(
        sectionHeadings(context.plan).map((h) => [h.index, h.heading])
      );
      const shown =
        language === "en"
          ? new Map<number, string>()
          : await localizeHeadings(
              graph.runtime,
              context.plan,
              language,
              getRequestContext()
            );
      const whys = await outLanguage(
        Object.fromEntries(
          [...sections.keys()].map((i) => [
            String(i),
            affected.find((a) => a.index === i)?.why ?? fallback,
          ])
        )
      );
      const changed = new Map<GenerationFlag, string[]>();
      const background: Proposal["background"] = [];
      for (const i of sections.keys()) {
        const field = fieldOfSection(heading.get(i)!);
        const why = whys[String(i)]!;
        if (field && context.fields.includes(field)) {
          changed.set(field, [...(changed.get(field) ?? []), why]);
        } else {
          background.push({
            section: i,
            heading: (shown.get(i) ?? heading.get(i)!).replace(/^#+\s*/, ""),
            summary: why,
          });
        }
      }
      return {
        changed: [...changed].map(([field, why]) => ({
          field,
          why: [...new Set(why)].join(" "),
        })),
        background,
      };
    }

    /** Refiner text is in the plan's language; the client reads the request's. */
    async function outLanguage(
      values: Record<string, string>
    ): Promise<Record<string, string>> {
      if (!sandwich || language === "en" || !graph.translateOutline)
        return values;
      return { ...values, ...(await graph.translateOutline(values, "out")) };
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
