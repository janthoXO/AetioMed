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
 * A job's plan (#159): the outline as the positional segment array. A
 * plan-mode plan is in the request language; a normal-mode plan is always
 * English. The language follows the mode, never the deployment, so a plan
 * handed back needs no language tag.
 */
export type PlanPayload = {
  jobId: string;
  mode: RunMode;
  language: Language;
  plan: OutlineSegments;
};

export type CaseGenerationResult = {
  jobId: string;
  /**
   * `planned` is where a plan-mode request without a plan stops (#159): the
   * call is over, and the generator keeps nothing of it — `plan` goes to the
   * requester, who sends it back with the next request.
   */
  status: "done" | "planned" | "failed";
  case?: Case;
  plan?: OutlineSegments;
  /**
   * The language generation actually ran in — the ladder's resolved output
   * (issue 10 §1), not necessarily `req.language` (which may have been
   * omitted). Set on success and on a plan stop: a request that fails
   * before generation runs (e.g. an unresolvable `icd`) never reaches
   * language resolution. Echoed back to the caller so a client can notice
   * a wrong auto-detect guess and retry with an explicit `language` (issue
   * 10 §5).
   */
  language?: Language;
  error?: CaseGenerationResultError;
};

/**
 * A job as {@link CaseGenerationService.start} hands it back: either
 * accepted — its channel is already open, and `result` settles when the
 * call ends — or rejected up front as a duplicate jobId (409).
 */
export type StartedJob =
  | { accepted: true; jobId: string; result: Promise<CaseGenerationResult> }
  | { accepted: false; jobId: string; result: CaseGenerationResult };

export type StartOptions = {
  /** A generation slot the caller already holds (the NATS worker). */
  slot?: Release;
  /**
   * Called with a normal-mode job's plan as soon as it exists, while the
   * case is still being generated (#159). A plan-mode job's plan is its
   * result instead. Must not throw; a slow listener delays nothing.
   */
  onPlan?: (plan: PlanPayload) => void;
};

/**
 * The single seam both transports (rest, nats) call through. Owns what both
 * used to duplicate: ICD→name resolution, jobId minting, `runWithContext`,
 * terminal event emission ("Generation Completed"/"Failure"/"Cancelled"),
 * and error→status mapping. It also owns each job's lifetime on the per-job
 * event channel (`core/jobEvents/`, #139): it opens the channel and closes it
 * with the job's outcome, so every transport sees the same lifecycle whatever
 * door the request came in through. Transports shrink to protocol
 * translation.
 *
 * **Stateless between calls (#159).** A call carries everything it needs —
 * the request, and optionally a plan — and nothing survives it: no job
 * record, no checkpoint, no stored API key. A call without a plan produces
 * one (plan mode stops there; normal mode goes on to the case); a call with
 * a plan skips planning and generates the case from it. Recovering a crashed
 * call is the transport's job: NATS redelivers an unacked request, and a
 * REST client resends.
 */
export interface CaseGenerationService {
  /**
   * Reserve the jobId, open its channel and start the job — all
   * synchronously, before this returns. A caller can therefore subscribe to
   * the job's events before any node runs, and learns about a duplicate
   * before it has committed to a response format (#143).
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

/**
 * How long a translated plan segment is remembered with the English it was
 * translated from (#159). Long enough for a reviewer to come back the same
 * day; a miss only costs one translation.
 */
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
    /** Bounds generations across every transport (#142). */
    maxConcurrent?: number;
    // Injectable for tests (a spy asserting the diagnosis name is never
    // passed to it — issue 10 §2); the real `tinyld`-backed detector by
    // default, constructed here rather than at module scope so nothing
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
  // One per job, from submission, so a job still queued for a slot can be
  // cancelled too.
  const controllers = new Map<string, AbortController>();

  // ─── the plan's round trip ────────────────────────────────────────────────

  // Translated segment → the English it came from (#159). Only the plan's
  // way out writes it, so an untouched segment comes back as its original
  // English rather than a re-translation, and only edited ones cost a call.
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
   * The plan a call was handed, in English, or an {@link InvalidPlanError}.
   * Its shape is the request schema's check; its skeleton is checked here,
   * not diffed against anything — the generator never saw this plan before
   * (#159). The fixed headings are what the
   * server owns, so they are restored by position rather than trusted from
   * a translation.
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
    // Provenance for the translate-in trigger (issue 12 §3): true only
    // when the caller actually supplied free text — a diagnosis name
    // (rather than only an `icd`) or any `userInstructions`. Computed
    // BEFORE ICD→name resolution below, which would otherwise make an
    // ICD-only request look identical to a free-text one.
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

    // The laddered resolver (issue 10 §1) — request normalisation
    // alongside the ICD→name resolution above, and deliberately run
    // *before* `runWithContext` binds the language: detection selects
    // which ports generation binds, and binding happens before invoke, so
    // a detection step inside the graph could not inform the thing its
    // answer is for.
    const language = await resolveLanguage({
      explicitLanguage: req.language,
      userInstructions: req.userInstructions,
      languages: graph.config.LANGUAGES,
      autoDetect: graph.config.LANGUAGE_AUTO_DETECT,
      llmFallbackEnabled: graph.config.LANGUAGE_DETECT_LLM_FALLBACK,
      detector,
      runtime: graph.runtime,
    });

    // A `procedures`-only request needs a presentation for the blinded
    // solver to reason from, so one is generated internally and projected
    // back out at the end. See `expandFlagsForSolver` for why the plan
    // outline is not used instead.
    const generationFlags = expandFlagsForSolver(req.generationFlags);
    const mode = req.mode ?? "normal";

    return runWithContext(
      async (): Promise<CaseGenerationResult> => {
        const plan =
          req.plan && (await englishPlanOf(req.plan, mode, language));

        // With a plan the plan graph only translates the request in (when
        // the sandwich needs it) and skips planning (#159).
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
            // Plan mode shows the outline even when the judge never
            // accepted it, and lets the reviewer judge.
            return {
              jobId,
              status: "planned",
              plan: translatesPlan(mode, language)
                ? await translatePlanOut(planned.outlineSegments, language)
                : planned.outlineSegments,
              language,
            };
          }
          // Normal mode never renders an outline the judge did not accept.
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

    // A jobId is an idempotency key — a duplicate must never start a
    // second generation. The one reuse the channel allows is the call that
    // follows a plan stop with the plan (#159).
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
        // Inside the `try` so a cancel while queued maps to
        // `GENERATION_CANCELLED`.
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
