import type { EventBus } from "./event-bus.js";
import type { JobEventChannel, JobOutcome } from "./jobEvents/index.js";
import { createLimiter, type Release } from "./concurrency.js";
import type { GraphAppContext } from "./graph/appContext.js";
import type { Case } from "./graph/models/Case.js";
import type { Language } from "./graph/models/Language.js";
import type { RunMode } from "./graph/models/RunMode.js";
import type { CaseGenerationRequest } from "@/api/index.js";
import { runWithContext } from "./graph/utils/context.js";
import { AppError, OutlineNotAcceptedError } from "./graph/errors/AppError.js";
import {
  expandFlagsForSolver,
  projectCaseToFlags,
} from "./graph/models/GenerationFlags.js";
import {
  checkSkeleton,
  joinOutline,
  restoreSkeletonHeadings,
  type OutlineSegments,
} from "./graph/outline/segments.js";
import type { LanguageDetector } from "./languageDetection/port.js";
import { createTinyldDetector } from "./languageDetection/tinyldDetector.js";
import { resolveLanguage } from "./languageDetection/resolveLanguage.js";

export type CaseGenerationResultError = {
  code: string;
  message: string;
  details?: string;
  /** HTTP status a REST transport should report; ignored by NATS. */
  statusCode?: number;
};

/**
 * Outline as positional segment array. Plan-mode plan: request language;
 * normal-mode plan: always English. No language tag needed on hand-back.
 */
export type PlanPayload = {
  jobId: string;
  mode: RunMode;
  language: Language;
  plan: OutlineSegments;
};

export type CaseGenerationResult = {
  jobId: string;
  /** `planned`: plan-mode request without a plan stops here; nothing kept. */
  status: "done" | "planned" | "failed";
  case?: Case;
  plan?: OutlineSegments;
  /**
   * Language generation ran in (resolved; `req.language` may be omitted).
   * Set on success and plan stop; absent if failed before resolution. Lets
   * client spot wrong auto-detect and retry explicitly.
   */
  language?: Language;
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
 * Single seam both transports call through. Owns ICD→name resolution, jobId
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

/** TTL for translated plan segment → source English. Miss costs one translation. */
const PLAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PLAN_CACHE_MAX_ENTRIES = 10_000;

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

/** Index-keyed values for the keyed translator. */
function indexed(texts: string[]): Record<string, string> {
  return Object.fromEntries(texts.map((text, i) => [String(i), text]));
}

export function createCaseGenerationService(
  graph: GraphAppContext,
  bus: EventBus,
  jobEvents: JobEventChannel,
  opts: {
    /** Bounds generations across every transport. */
    maxConcurrent?: number;
    // Injectable for tests; default `tinyld` detector, built here so nothing
    // runs at import time.
    detector?: LanguageDetector;
    now?: () => number;
  } = {}
): CaseGenerationService {
  const detector = opts.detector ?? createTinyldDetector();
  const limiter = createLimiter(
    opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_GENERATIONS
  );
  const now = opts.now ?? Date.now;
  const sandwich = graph.config.TRANSLATION_SANDWICH;
  // One per job from submission, so queued jobs are cancellable.
  const controllers = new Map<string, AbortController>();

  // ─── the plan's round trip ────────────────────────────────────────────────

  // Translated segment → source English. Written only by plan-out, so an
  // untouched segment returns as original English; only edited ones cost a call.
  // ponytail: per-replica and in memory — a restart or another replica just
  // translates again; share it (e.g. NATS KV) if that ever shows in cost.
  const planCache = new Map<string, { english: string; expires: number }>();
  const cacheKey = (language: Language, text: string) =>
    `${language}\u0000${text}`;

  /** Whether a plan-mode plan crosses the sandwich for this request. */
  function translatesPlan(mode: RunMode, language: Language): boolean {
    return mode === "plan" && sandwich && language !== "English";
  }

  async function translatePlanOut(
    english: OutlineSegments,
    language: Language
  ): Promise<OutlineSegments> {
    const translated = await graph.translateOutline!(
      indexed(english.map((s) => s.text)),
      "out"
    );
    const expires = now() + PLAN_CACHE_TTL_MS;
    return english.map((segment, i) => {
      const text = translated[String(i)] ?? segment.text;
      planCache.delete(cacheKey(language, text)); // refresh insertion order
      planCache.set(cacheKey(language, text), {
        english: segment.text,
        expires,
      });
      return { fixed: segment.fixed, text };
    });
  }

  async function translatePlanIn(
    plan: OutlineSegments,
    language: Language
  ): Promise<OutlineSegments> {
    const english = plan.map((segment) => {
      const hit = planCache.get(cacheKey(language, segment.text));
      return hit && hit.expires > now() ? hit.english : undefined;
    });
    const misses = plan.flatMap((segment, i) =>
      english[i] === undefined && segment.text.trim() !== "" ? [i] : []
    );
    if (misses.length > 0) {
      const translated = await graph.translateOutline!(
        Object.fromEntries(misses.map((i) => [String(i), plan[i]!.text])),
        "in"
      );
      for (const i of misses) english[i] = translated[String(i)];
    }
    return plan.map((segment, i) => ({
      fixed: segment.fixed,
      text: english[i] ?? segment.text,
    }));
  }

  function evictPlanCache(): void {
    const at = now();
    for (const [key, entry] of planCache) {
      if (entry.expires <= at || planCache.size > PLAN_CACHE_MAX_ENTRIES) {
        planCache.delete(key);
      }
    }
  }

  /**
   * Handed-in plan in English, or {@link InvalidPlanError}. Shape checked by
   * request schema; skeleton checked here. Fixed headings are server-owned,
   * restored by position, not trusted from a translation.
   */
  async function englishPlanOf(
    plan: OutlineSegments,
    mode: RunMode,
    language: Language
  ): Promise<OutlineSegments> {
    const anamnesisCategories = graph.runtime.catalogs.anamnesis.list();
    const english = translatesPlan(mode, language)
      ? restoreSkeletonHeadings(await translatePlanIn(plan, language), {
          anamnesisCategories,
        })
      : plan;
    const skeleton = checkSkeleton(english, { anamnesisCategories });
    if (!skeleton.ok) throw new InvalidPlanError(skeleton.message);
    return english;
  }

  // ─── one call ─────────────────────────────────────────────────────────────

  async function run(
    req: CaseGenerationRequest,
    jobId: string,
    startOpts: StartOptions,
    signal: AbortSignal
  ): Promise<CaseGenerationResult> {
    // Translate-in trigger: caller supplied a diagnosis name or
    // `userInstructions`. Compute BEFORE ICD→name resolution, which would
    // make ICD-only look like free text.
    const callerSuppliedFreeText =
      Boolean(req.diagnosis) ||
      (req.userInstructions !== undefined &&
        Object.keys(req.userInstructions).length > 0);

    let diagnosisName = req.diagnosis;
    if (!diagnosisName) {
      diagnosisName = graph.runtime.catalogs.diagnosis.byIcd(req.icd!)?.name;
      if (!diagnosisName) {
        return failure(
          jobId,
          "INVALID_REQUEST_BODY",
          "No diagnosis found for icd",
          400
        );
      }
    }

    // Must run before `runWithContext` binds language: detection selects
    // the ports generation binds.
    const language = await resolveLanguage({
      explicitLanguage: req.language,
      userInstructions: req.userInstructions,
      languages: graph.config.LANGUAGES,
      autoDetect: graph.config.LANGUAGE_AUTO_DETECT,
      llmFallbackEnabled: graph.config.LANGUAGE_DETECT_LLM_FALLBACK,
      detector,
      runtime: graph.runtime,
    });

    // `procedures`-only request: blinded solver needs a presentation, so
    // generate internally, project out at end. See `expandFlagsForSolver`.
    const generationFlags = expandFlagsForSolver(req.generationFlags);
    const mode = req.mode ?? "normal";

    return runWithContext(
      async (): Promise<CaseGenerationResult> => {
        const plan =
          req.plan && (await englishPlanOf(req.plan, mode, language));

        // With a plan, plan graph only translates request in (if sandwich
        // needs it); planning skipped.
        const planned = await graph.planCase({
          diagnosis: { name: diagnosisName, icd: req.icd },
          generationFlags,
          userInstructions: req.userInstructions,
          language,
          difficulty: req.difficulty,
          callerSuppliedFreeText,
          mode,
          outline: plan,
        });

        if (!plan) {
          if (mode === "plan") {
            // Shown even if judge never accepted; reviewer judges.
            return {
              jobId,
              status: "planned",
              plan: translatesPlan(mode, language)
                ? await translatePlanOut(planned.outlineSegments, language)
                : planned.outlineSegments,
              language,
            };
          }
          // Never render an unaccepted outline.
          if (!planned.outlineAccepted) throw new OutlineNotAcceptedError();
          startOpts.onPlan?.({
            jobId,
            mode,
            language,
            plan: planned.outlineSegments,
          });
        }

        const fullCase = await graph.renderCase({
          diagnosis: planned.diagnosis,
          generationFlags,
          userInstructions: planned.userInstructions,
          difficulty: req.difficulty,
          outline: joinOutline(plan ?? planned.outlineSegments),
        });
        return {
          jobId,
          status: "done",
          case:
            generationFlags !== req.generationFlags
              ? projectCaseToFlags(fullCase, req.generationFlags)
              : fullCase,
          language,
        };
      },
      jobId,
      req.llmConfig,
      language,
      signal
    );
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
    evictPlanCache();

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
