import type { EventBus } from "./event-bus.js";
import type { GraphAppContext } from "./graph/appContext.js";
import type { Case } from "./graph/models/Case.js";
import type { Language } from "./graph/models/Language.js";
import type { CaseGenerationRequest } from "@/api/index.js";
import { runWithContext } from "./graph/utils/context.js";
import * as cancelManager from "./graph/utils/cancelManager.js";
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
 * and error→status mapping. Transports shrink to protocol translation: parse
 * their wire format into a `CaseGenerationRequest`, call `generate`, and
 * translate the `CaseGenerationResult` back into their wire format.
 *
 * Returns a job shape, not a bare `Case` — a synchronous transport (REST)
 * still blocks on the promise, but the shape itself already accommodates a
 * future non-`"done"`/`"failed"` status (e.g. human-in-the-loop's
 * `"awaiting_review"`) without a breaking change.
 */
export interface CaseGenerationService {
  generate(
    req: CaseGenerationRequest & { jobId?: string }
  ): Promise<CaseGenerationResult>;
  cancel(jobId: string): boolean;
}

export function createCaseGenerationService(
  graph: GraphAppContext,
  bus: EventBus,
  // Injectable for tests (a spy asserting the diagnosis name is never
  // passed to it — issue 10 §2); the real `tinyld`-backed detector by
  // default, constructed here rather than at module scope so nothing runs
  // at import time.
  detector: LanguageDetector = createTinyldDetector()
): CaseGenerationService {
  return {
    async generate(req): Promise<CaseGenerationResult> {
      const jobId = req.jobId ?? crypto.randomUUID();

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
          resolvedLanguage
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
    },

    cancel(jobId: string): boolean {
      return cancelManager.abort(jobId);
    },
  };
}
