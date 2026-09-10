import type { EventBus } from "./event-bus.js";
import type { JobEventChannel, JobOutcome } from "./jobEvents/index.js";
import { createLimiter, type Release } from "./concurrency.js";
import type { GraphAppContext } from "./graph/appContext.js";
import type { Case } from "./graph/models/Case.js";
import type { Language } from "./graph/models/Language.js";
import type { CaseGenerationRequest } from "@/api/index.js";
import { runWithContext } from "./graph/utils/context.js";
import { AppError } from "./graph/errors/AppError.js";
import {
  expandFlagsForSolver,
  projectCaseToFlags,
} from "./graph/models/GenerationFlags.js";
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

export type CaseGenerationResult = {
  jobId: string;
  status: "done" | "failed";
  case?: Case;
  /**
   * The language generation actually ran in — the ladder's resolved output
   * (issue 10 §1), not necessarily `req.language` (which may have been
   * omitted). Only set on success: a request that fails before generation
   * runs (e.g. an unresolvable `icd`) never reaches language resolution.
   * Echoed back to the caller so a client can notice a wrong auto-detect
   * guess and retry with an explicit `language` (issue 10 §5).
   */
  language?: Language;
  error?: CaseGenerationResultError;
};

/**
 * The single seam both transports (rest, nats) call through. Owns what both
 * used to duplicate: ICD→name resolution, jobId minting, `runWithContext`,
 * terminal event emission ("Generation Completed"/"Failure"/"Cancelled"),
 * and error→status mapping. It also owns each job's lifetime on the per-job
 * event channel (`core/jobEvents/`, #139): it opens the channel and closes it
 * with the job's outcome, so every transport sees the same lifecycle whatever
 * door the request came in through. Transports shrink to protocol translation: parse
 * their wire format into a `CaseGenerationRequest`, call `generate`, and
 * translate the `CaseGenerationResult` back into their wire format.
 *
 * Returns a job shape, not a bare `Case` — a synchronous transport (REST)
 * still blocks on the promise, but the shape itself already accommodates a
 * future non-`"done"`/`"failed"` status (e.g. human-in-the-loop's
 * `"awaiting_review"`) without a breaking change.
 */
/**
 * A job as {@link CaseGenerationService.start} hands it back: either
 * accepted — its channel is already open, and `result` settles when it
 * ends — or rejected up front as a duplicate jobId (409).
 */
export type StartedJob =
  | { accepted: true; jobId: string; result: Promise<CaseGenerationResult> }
  | { accepted: false; jobId: string; result: CaseGenerationResult };

export interface CaseGenerationService {
  /**
   * Reserve the jobId, open its channel and start the job — all
   * synchronously, before this returns. A caller can therefore subscribe to
   * the job's events before any node runs, and learns about a duplicate
   * before it has committed to a response format (#143).
   */
  start(req: CaseGenerationRequest, opts?: { slot?: Release }): StartedJob;
  /**
   * {@link start}, awaited. Waits for a slot under `MAX_CONCURRENT_GENERATIONS` Waits for a slot under `MAX_CONCURRENT_GENERATIONS`
   * unless `opts.slot` hands in one the caller already holds — the NATS
   * consumer does, so it only pulls a message off the stream once it can
   * run it. Either way the service releases the slot when the job ends.
   */
  generate(
    req: CaseGenerationRequest,
    opts?: { slot?: Release }
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
  } = {}
): CaseGenerationService {
  const detector = opts.detector ?? createTinyldDetector();
  const limiter = createLimiter(
    opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_GENERATIONS
  );
  // One per job, registered at submission rather than when generation
  // starts, so a job still queued for a slot can be cancelled too.
  const controllers = new Map<string, AbortController>();

  async function run(
    req: CaseGenerationRequest,
    jobId: string,
    signal: AbortSignal,
    acquireSlot: () => Promise<void>
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
        return {
          jobId,
          status: "failed",
          error: {
            code: "INVALID_REQUEST_BODY",
            message: "No diagnosis found for icd",
            statusCode: 400,
          },
        };
      }
    }

    // A `procedures`-only request needs a presentation for the blinded
    // solver to reason from, so one is generated internally and projected
    // back out below. See `expandFlagsForSolver` for why the plan outline
    // is not used instead.
    const effectiveFlags = expandFlagsForSolver(req.generationFlags);

    // The laddered resolver (issue 10 §1) — request normalisation
    // alongside the ICD→name resolution above, and deliberately run
    // *before* `runWithContext` binds the language: detection selects
    // which ports generation binds, and binding happens before invoke, so
    // a detection step inside the graph could not inform the thing its
    // answer is for.
    const resolvedLanguage = await resolveLanguage({
      explicitLanguage: req.language,
      userInstructions: req.userInstructions,
      languages: graph.config.LANGUAGES,
      autoDetect: graph.config.LANGUAGE_AUTO_DETECT,
      llmFallbackEnabled: graph.config.LANGUAGE_DETECT_LLM_FALLBACK,
      detector,
      runtime: graph.runtime,
    });

    try {
      // Queued only once the request is known to be runnable: a bad ICD
      // above answers at once instead of waiting behind other jobs. Inside
      // the `try` so a cancel while queued maps to `GENERATION_CANCELLED`.
      await acquireSlot();
      const fullCase = await runWithContext(
        () =>
          graph.generateCase({
            diagnosis: { name: diagnosisName!, icd: req.icd },
            generationFlags: effectiveFlags,
            userInstructions: req.userInstructions,
            language: resolvedLanguage,
            difficulty: req.difficulty,
            callerSuppliedFreeText,
          }),
        jobId,
        req.llmConfig,
        resolvedLanguage,
        signal
      );

      const generatedCase =
        effectiveFlags === req.generationFlags
          ? fullCase
          : projectCaseToFlags(fullCase, req.generationFlags);

      bus.emit("Generation Completed", { case: generatedCase, jobId });

      return {
        jobId,
        status: "done",
        case: generatedCase,
        language: resolvedLanguage,
      };
    } catch (error) {
      console.error(error);

      if (error instanceof Error && error.name === "AbortError") {
        bus.emit("Generation Cancelled", { jobId });
        return {
          jobId,
          status: "failed",
          error: {
            code: "GENERATION_CANCELLED",
            message: "Generation was cancelled",
            statusCode: 499,
          },
        };
      }

      if (error instanceof Error) {
        bus.emit("Generation Failure", { error, jobId });
      }

      if (error instanceof AppError) {
        return {
          jobId,
          status: "failed",
          error: {
            code: error.code,
            message: error.message,
            ...(error.details !== undefined && { details: error.details }),
            statusCode: error.statusCode,
          },
        };
      }

      return {
        jobId,
        status: "failed",
        error: {
          code: "GENERATION_FAILED",
          message: "Internal server error",
          details: error instanceof Error ? error.message : String(error),
          statusCode: 500,
        },
      };
    }
  }

  async function execute(
    req: CaseGenerationRequest,
    jobId: string,
    controller: AbortController,
    slot: Release | undefined
  ): Promise<CaseGenerationResult> {
    let release = slot;
    const acquireSlot = async () => {
      release ??= await limiter.acquire(controller.signal);
    };

    try {
      const result = await run(req, jobId, controller.signal, acquireSlot);
      jobEvents.close(jobId, outcomeOf(result));
      return result;
    } catch (error) {
      jobEvents.close(jobId, {
        status: "failed",
        error: {
          code: "GENERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    } finally {
      release?.();
      controllers.delete(jobId);
    }
  }

  function start(
    req: CaseGenerationRequest,
    opts: { slot?: Release } = {}
  ): StartedJob {
    const jobId = req.jobId ?? crypto.randomUUID();

    // A jobId is an idempotency key — a duplicate must never start a
    // second generation.
    if (!jobEvents.open(jobId)) {
      opts.slot?.();
      const active = jobEvents.state(jobId) === "active";
      return {
        accepted: false,
        jobId,
        result: {
          jobId,
          status: "failed",
          error: {
            code: active ? "JOB_ALREADY_ACTIVE" : "JOB_ALREADY_COMPLETED",
            message: active
              ? "A generation with this jobId is already running"
              : "A generation with this jobId has already finished",
            statusCode: 409,
          },
        },
      };
    }

    const controller = new AbortController();
    controllers.set(jobId, controller);
    return {
      accepted: true,
      jobId,
      result: execute(req, jobId, controller, opts.slot),
    };
  }

  return {
    start,

    async generate(req, opts = {}): Promise<CaseGenerationResult> {
      return start(req, opts).result;
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
