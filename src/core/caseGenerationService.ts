import type { EventBus } from "./event-bus.js";
import type { JobEventChannel, JobOutcome } from "./jobEvents/index.js";
import { createLimiter, type Release } from "./concurrency.js";
import type { GraphAppContext } from "./graph/appContext.js";
import type { Case } from "./graph/models/Case.js";
import type { Diagnosis } from "./graph/models/Diagnosis.js";
import type { GenerationFlag } from "./graph/models/GenerationFlags.js";
import type { Language } from "./graph/models/Language.js";
import type { LLMConfig } from "./graph/models/LLMConfig.js";
import type { UserInstructions } from "./graph/models/UserInstructions.js";
import type { BasisFragment } from "./graph/medicalBasis/ports.js";
import type {
  CaseGenerationRequest,
  ReviewDecisionRequest,
} from "@/api/index.js";
import { runWithContext } from "./graph/utils/context.js";
import {
  AppError,
  GenerationError,
  OutlineNotAcceptedError,
} from "./graph/errors/AppError.js";
import {
  expandFlagsForSolver,
  projectCaseToFlags,
} from "./graph/models/GenerationFlags.js";
import {
  compareSubmission,
  joinOutline,
  mergeSegments,
  type OutlineSegments,
} from "./graph/outline/segments.js";
import type { LanguageDetector } from "./languageDetection/port.js";
import { createTinyldDetector } from "./languageDetection/tinyldDetector.js";
import { resolveLanguage } from "./languageDetection/resolveLanguage.js";
import type { JobRecordRepo } from "./jobs/repo.js";
import type { JobRecord, JobStatus, JobTransport } from "./jobs/record.js";
import { createInMemoryJobRecordRepo } from "./jobs/memoryRepo.js";
import type { SecretBox } from "./jobs/secretBox.js";

export type CaseGenerationResultError = {
  code: string;
  message: string;
  details?: string;
  /** HTTP status a REST transport should report; ignored by NATS. */
  statusCode?: number;
};

/**
 * What a paused plan-mode job shows its reviewer (#159). `outline` is the
 * positional segment array in the request language; a decision must quote
 * `revision` and hand back the same number of segments, with every fixed
 * segment unchanged.
 */
export type ReviewPayload = {
  jobId: string;
  revision: number;
  language: Language;
  outline: OutlineSegments;
  /**
   * Revision feedback the reviewer had submitted when a restart interrupted
   * the revision (#159) — prefilled so it is not lost.
   */
  pendingFeedback?: string[];
  expiresAt: string;
};

export type CaseGenerationResult = {
  jobId: string;
  /**
   * `awaiting_review` is where a plan-mode segment stops (#159): the job is
   * paused, not finished, and `review` says what it waits on.
   */
  status: "done" | "failed" | "awaiting_review";
  case?: Case;
  review?: ReviewPayload;
  /**
   * The language generation actually ran in — the ladder's resolved output
   * (issue 10 §1), not necessarily `req.language` (which may have been
   * omitted). Set on success and on a review stop: a request that fails
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
 * accepted — its channel is already open, and `result` settles at the
 * first stop (a review or the end) — or rejected up front as a duplicate
 * jobId (409).
 */
export type StartedJob =
  | { accepted: true; jobId: string; result: Promise<CaseGenerationResult> }
  | { accepted: false; jobId: string; result: CaseGenerationResult };

/** A decision on a paused job: accepted (the next segment runs) or refused. */
export type DecisionOutcome =
  | { accepted: true; jobId: string; result: Promise<CaseGenerationResult> }
  | { accepted: false; jobId: string; error: CaseGenerationResultError };

/** A job {@link CaseGenerationService.resume} picked back up after a restart. */
export type ResumedJob = {
  jobId: string;
  result: Promise<CaseGenerationResult>;
};

export type StartOptions = {
  /** A generation slot the caller already holds (the NATS worker). */
  slot?: Release;
  /** Which transport the job belongs to — decides how a restart recovers it. */
  transport?: JobTransport;
  /**
   * Called once the first outline is saved (#159): from then on a crash
   * resumes from the checkpoint, so the NATS worker acks its request here
   * and a crash before this point is simply redelivered.
   */
  onCheckpoint?: () => void;
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
 * Since #159 a job runs as one or more **segments** between checkpoints in
 * the job record: the plan graph, the outline translations and the case
 * graph are separate runs, and the record is written between them. Normal
 * mode is one segment; plan mode stops at a review and continues on a
 * decision. A paused job holds no slot, no controller and no connection —
 * only its record and its (open) event channel.
 */
export interface CaseGenerationService {
  /**
   * Reserve the jobId, open its channel and start the job — all
   * synchronously, before this returns. A caller can therefore subscribe to
   * the job's events before any node runs, and learns about a duplicate
   * before it has committed to a response format (#143).
   */
  start(req: CaseGenerationRequest, opts?: StartOptions): StartedJob;
  /** {@link start}, awaited: settles at the first stop. */
  generate(
    req: CaseGenerationRequest,
    opts?: StartOptions
  ): Promise<CaseGenerationResult>;
  /** Wait for a free generation slot, to pass to {@link generate}. */
  reserveSlot(): Promise<Release>;
  /**
   * Abort a running or queued job, or end a paused one. `false` if this
   * process has no such job.
   */
  cancel(jobId: string): boolean;
  /** The pending review of a paused job, or `undefined`. */
  getReview(jobId: string): ReviewPayload | undefined;
  /**
   * Apply a reviewer's decision (#159). Refused synchronously (stale
   * revision, invalid outline, not paused); accepted, the next segment runs
   * with priority over new requests and `result` settles at its stop.
   */
  decide(jobId: string, request: ReviewDecisionRequest): DecisionOutcome;
  /**
   * Pick up this transport's checkpointed jobs after a restart (#159):
   * paused jobs wait again, jobs past the first outline resume or go back
   * to review, and everything else ends. Returns the jobs whose next stop
   * the transport must deliver.
   */
  resume(transport: JobTransport): ResumedJob[];
  /**
   * Outcomes nobody is waiting on: a paused job cancelled or expired. NATS
   * publishes these to the job's stop subject (#159's `publishStop`) —
   * `transport` says which transport owns the job, so a non-NATS transport
   * (today, only `"rest"`, which has no channel-less way to deliver this)
   * is not mistakenly published to a NATS subject.
   */
  onDetachedOutcome(
    listener: (result: CaseGenerationResult, transport: JobTransport) => void
  ): () => void;
  /** Stop the review-expiry sweep. */
  close(): void;
}

export const DEFAULT_MAX_CONCURRENT_GENERATIONS = 4;
export const DEFAULT_REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
const SWEEP_INTERVAL_MS = 60 * 1000;

/** Bumped when {@link JobData}'s shape changes; older records are expired. */
const JOB_DATA_SCHEMA = 1;

/**
 * The job record's payload (#159) — everything a later segment, or a
 * restarted process, needs. Never the API key: that is `encryptedApiKey`.
 */
type JobData = {
  schema: number;
  /** The deployment variant that wrote this record. */
  sandwich: boolean;
  request: Omit<CaseGenerationRequest, "llmConfig"> & {
    llmConfig?: Omit<LLMConfig, "apiKey">;
  };
  language: Language;
  diagnosis: Diagnosis;
  generationFlags: GenerationFlag[];
  /**
   * The flags the caller asked for, when `generationFlags` was expanded for
   * the solver — the finished case is projected back onto these.
   */
  projectTo?: GenerationFlag[];
  callerSuppliedFreeText: boolean;
  reviewRounds: number;
  /** Working-language inputs from the plan graph. */
  plan?: {
    diagnosis: Diagnosis;
    userInstructions?: UserInstructions | undefined;
    basisFragments: BasisFragment[];
  };
  /** Checkpoint 1: the outline as generated, in the working language. */
  original?: OutlineSegments;
  /** Checkpoint 2: the outline as shown to the reviewer. */
  display?: OutlineSegments;
  /** Checkpoint 3: the reviewer's submission (3r: with `pendingFeedback`). */
  reviewed?: OutlineSegments;
  pendingFeedback?: string[];
  /** Checkpoint 4: the reviewed outline in the working language. */
  merged?: OutlineSegments;
};

function dataOf(record: JobRecord): JobData {
  return record.data as JobData;
}

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

function refusal(
  jobId: string,
  code: string,
  message: string,
  statusCode: number
): DecisionOutcome {
  return { accepted: false, jobId, error: { code, message, statusCode } };
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
    /**
     * Where checkpoints live (#159). The composition root passes the
     * embedded database's repo; without one, checkpoints are in memory and
     * do not survive a restart.
     */
    jobRecords?: JobRecordRepo;
    /** Encrypts per-request API keys at rest (`JOB_ENCRYPTION_KEY`). */
    secretBox?: SecretBox | undefined;
    reviewTtlMs?: number;
    maxReviewRounds?: number;
    now?: () => number;
  } = {}
): CaseGenerationService {
  const detector = opts.detector ?? createTinyldDetector();
  const limiter = createLimiter(
    opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_GENERATIONS
  );
  const records = opts.jobRecords ?? createInMemoryJobRecordRepo();
  const reviewTtlMs = opts.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS;
  const maxReviewRounds = opts.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
  const now = opts.now ?? Date.now;
  const sandwich = graph.config.TRANSLATION_SANDWICH;
  // One per running segment — and for a new job, from submission, so a job
  // still queued for a slot can be cancelled too. A paused job has none.
  const controllers = new Map<string, AbortController>();
  const detachedListeners = new Set<
    (result: CaseGenerationResult, transport: JobTransport) => void
  >();

  // ─── request normalisation ────────────────────────────────────────────────

  async function prepare(
    req: CaseGenerationRequest,
    jobId: string
  ): Promise<JobData | CaseGenerationResult> {
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

    // The API key never enters the record's JSON — see `encryptedApiKey`.
    const { llmConfig, ...rest } = req;
    const storedLlmConfig = llmConfig && { ...llmConfig };
    if (storedLlmConfig) delete storedLlmConfig.apiKey;

    return {
      schema: JOB_DATA_SCHEMA,
      sandwich,
      request: {
        ...rest,
        ...(storedLlmConfig && { llmConfig: storedLlmConfig }),
      },
      language,
      diagnosis: { name: diagnosisName, icd: req.icd },
      generationFlags,
      ...(generationFlags !== req.generationFlags && {
        projectTo: req.generationFlags,
      }),
      callerSuppliedFreeText,
      reviewRounds: 0,
    };
  }

  /** The full LLM config of a job, API key decrypted — memory only. */
  function llmConfigOf(record: JobRecord): LLMConfig | undefined {
    const stored = dataOf(record).request.llmConfig;
    if (!stored) return undefined;
    if (!record.encryptedApiKey) return stored as LLMConfig;
    if (!opts.secretBox) {
      throw new GenerationError(
        "Job holds an encrypted API key but JOB_ENCRYPTION_KEY is not configured"
      );
    }
    return {
      ...(stored as LLMConfig),
      apiKey: opts.secretBox.open(record.encryptedApiKey),
    };
  }

  // ─── checkpoints ──────────────────────────────────────────────────────────

  /**
   * Whether plan mode translates the outline for this job (#159). True only
   * when the record was written with the sandwich on — and `resume` rejects
   * records from a different variant — so `graph.translateOutline` exists
   * whenever this holds.
   */
  function translatesOutline(data: JobData): boolean {
    return data.sandwich && data.language !== "English";
  }

  /** Write a checkpoint; the record must still be where this segment left it. */
  function checkpoint(record: JobRecord, patch: Partial<JobRecord>): void {
    const written = records.update(record.jobId, patch, {
      status: [record.status],
      revision: record.revision,
    });
    if (!written) {
      throw new GenerationError(
        `Job ${record.jobId} changed while a segment was running`
      );
    }
  }

  /** The patch that pauses a job for (another) review. */
  function reviewPatch(record: JobRecord, data: JobData): Partial<JobRecord> {
    return {
      status: "awaiting_review",
      revision: record.revision + 1,
      expiresAt: now() + reviewTtlMs,
      data,
    };
  }

  /** Where a fresh or revised outline goes next in plan mode. */
  function afterOutline(record: JobRecord, data: JobData): Partial<JobRecord> {
    return translatesOutline(data)
      ? { status: "outline_ready", data }
      : reviewPatch(record, { ...data, display: data.original! });
  }

  function reviewOf(record: JobRecord): ReviewPayload {
    const data = dataOf(record);
    return {
      jobId: record.jobId,
      revision: record.revision,
      language: data.language,
      outline: data.reviewed ?? data.display!,
      ...(data.pendingFeedback && { pendingFeedback: data.pendingFeedback }),
      expiresAt: new Date(record.expiresAt ?? now()).toISOString(),
    };
  }

  /**
   * Run the job from its current checkpoint to its next stop, writing a
   * checkpoint after every step. Each step is one graph run (or none).
   */
  async function advance(
    jobId: string,
    onCheckpoint?: () => void
  ): Promise<CaseGenerationResult> {
    for (;;) {
      const record = records.get(jobId);
      if (!record) throw new GenerationError(`Job ${jobId} has no record`);
      const data = dataOf(record);

      switch (record.status) {
        case "planning": {
          const plan = await graph.planCase({
            diagnosis: data.diagnosis,
            generationFlags: data.generationFlags,
            userInstructions: data.request.userInstructions,
            language: data.language,
            difficulty: data.request.difficulty,
            callerSuppliedFreeText: data.callerSuppliedFreeText,
            mode: record.mode,
          });
          // Normal mode never renders an outline the judge did not accept;
          // plan mode shows it anyway and lets the reviewer judge (#159).
          if (record.mode === "normal" && !plan.outlineAccepted) {
            throw new OutlineNotAcceptedError();
          }
          const planned: JobData = {
            ...data,
            plan: {
              diagnosis: plan.diagnosis,
              userInstructions: plan.userInstructions,
              basisFragments: plan.basisFragments,
            },
            original: plan.outlineSegments,
          };
          checkpoint(
            record,
            record.mode === "normal"
              ? { status: "ready_to_generate", data: planned }
              : afterOutline(record, planned)
          );
          onCheckpoint?.();
          continue;
        }

        case "revising": {
          let feedback = data.pendingFeedback ?? [];
          if (translatesOutline(data)) {
            const translated = await graph.translateOutline!(
              indexed(feedback),
              "in"
            );
            feedback = feedback.map((f, i) => translated[String(i)] ?? f);
          }
          // Working-language inputs and no free text: translate-in is
          // skipped and the saved basis is reused.
          const plan = await graph.planCase({
            diagnosis: data.plan!.diagnosis,
            generationFlags: data.generationFlags,
            userInstructions: data.plan!.userInstructions,
            language: data.language,
            difficulty: data.request.difficulty,
            callerSuppliedFreeText: false,
            mode: record.mode,
            revise: {
              outlineSegments: data.original!,
              feedback,
              basisFragments: data.plan!.basisFragments,
            },
          });
          const revised: JobData = { ...data, original: plan.outlineSegments };
          delete revised.display;
          delete revised.reviewed;
          delete revised.merged;
          delete revised.pendingFeedback;
          checkpoint(record, afterOutline(record, revised));
          continue;
        }

        case "outline_ready": {
          // The sandwich's middle layer, out (#159): every segment, fixed
          // ones included for display — the server never reads them back.
          const original = data.original!;
          const translated = await graph.translateOutline!(
            indexed(original.map((s) => s.text)),
            "out"
          );
          const display = original.map((s, i) => ({
            fixed: s.fixed,
            text: translated[String(i)] ?? s.text,
          }));
          checkpoint(record, reviewPatch(record, { ...data, display }));
          continue;
        }

        case "awaiting_review": {
          jobEvents.publish(jobId, "awaiting_review", {
            jobId,
            revision: record.revision,
            timestamp: new Date(now()).toISOString(),
          });
          return {
            jobId,
            status: "awaiting_review",
            review: reviewOf(record),
            language: data.language,
          };
        }

        case "edits_received": {
          let merged = data.merged;
          if (!merged) {
            const display = data.display!;
            const reviewed = data.reviewed!;
            const comparison = compareSubmission(display, reviewed);
            if (!comparison.ok) throw new GenerationError(comparison.message);
            // Only what the reviewer changed is translated back (#159);
            // every other segment keeps the original's text.
            const changed = Object.fromEntries(
              comparison.changed.map((i) => [String(i), reviewed[i]!.text])
            );
            const replacements =
              translatesOutline(data) && Object.keys(changed).length > 0
                ? await graph.translateOutline!(changed, "in")
                : changed;
            merged = mergeSegments(
              data.original!,
              new Map(
                Object.entries(replacements).map(([i, text]) => [
                  Number(i),
                  text,
                ])
              )
            );
          }
          checkpoint(record, {
            status: "ready_to_generate",
            data: { ...data, merged },
          });
          continue;
        }

        case "ready_to_generate": {
          checkpoint(record, { status: "generating" });
          continue;
        }

        case "generating": {
          const fullCase = await graph.renderCase({
            diagnosis: data.plan!.diagnosis,
            generationFlags: data.generationFlags,
            userInstructions: data.plan!.userInstructions,
            difficulty: data.request.difficulty,
            outline: joinOutline(data.merged ?? data.original!),
          });
          const generatedCase = data.projectTo
            ? projectCaseToFlags(fullCase, data.projectTo)
            : fullCase;
          return {
            jobId,
            status: "done",
            case: generatedCase,
            language: data.language,
          };
        }
      }
    }
  }

  // ─── segments ─────────────────────────────────────────────────────────────

  function end(jobId: string, result: CaseGenerationResult): void {
    records.delete(jobId);
    jobEvents.close(jobId, outcomeOf(result));
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

  /**
   * Run one segment: take a slot, bind the request's context, advance to the
   * next stop, release the slot. A stop at a review leaves the job (and its
   * channel) open; anything else ends it.
   */
  async function runSegment(
    jobId: string,
    segment: {
      controller?: AbortController;
      slot?: Release | undefined;
      priority: "high" | "normal";
      onCheckpoint?: (() => void) | undefined;
    }
  ): Promise<CaseGenerationResult> {
    const controller = segment.controller ?? new AbortController();
    controllers.set(jobId, controller);
    let release = segment.slot;

    try {
      // Inside the `try` so a cancel while queued maps to
      // `GENERATION_CANCELLED`.
      release ??= await limiter.acquire(controller.signal, {
        priority: segment.priority,
      });
      const record = records.get(jobId);
      if (!record) throw new GenerationError(`Job ${jobId} has no record`);

      const result = await runWithContext(
        () => advance(jobId, segment.onCheckpoint),
        jobId,
        llmConfigOf(record),
        dataOf(record).language,
        controller.signal
      );

      if (result.status === "done") {
        bus.emit("Generation Completed", { case: result.case!, jobId });
        end(jobId, result);
      }
      return result;
    } catch (error) {
      const result = errorResult(jobId, error);
      end(jobId, result);
      return result;
    } finally {
      release?.();
      controllers.delete(jobId);
    }
  }

  function notifyDetached(
    result: CaseGenerationResult,
    transport: JobTransport
  ): void {
    for (const listener of [...detachedListeners]) {
      try {
        listener(result, transport);
      } catch (error) {
        console.error("[jobs] Detached-outcome listener failed", error);
      }
    }
  }

  /** End a paused job nobody is waiting on — cancelled or expired. */
  function endPaused(record: JobRecord, result: CaseGenerationResult): void {
    end(record.jobId, result);
    notifyDetached(result, record.transport);
  }

  function sweepExpired(): void {
    for (const record of records.listExpired(now())) {
      if (record.status !== "awaiting_review" || controllers.has(record.jobId))
        continue;
      endPaused(
        record,
        failure(
          record.jobId,
          "REVIEW_EXPIRED",
          "The review time limit passed without a decision",
          410
        )
      );
    }
  }

  const sweep = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  // ─── the public surface ───────────────────────────────────────────────────

  function start(
    req: CaseGenerationRequest,
    startOpts: StartOptions = {}
  ): StartedJob {
    const jobId = req.jobId ?? crypto.randomUUID();

    // A jobId is an idempotency key — a duplicate must never start a
    // second generation, including one whose record is paused or was
    // checkpointed by another transport.
    if (records.get(jobId) || !jobEvents.open(jobId)) {
      startOpts.slot?.();
      const active =
        records.get(jobId) !== undefined || jobEvents.state(jobId) === "active";
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
      let data: JobData | CaseGenerationResult;
      try {
        data = await prepare(req, jobId);
      } catch (error) {
        data = errorResult(jobId, error);
      }
      if ("status" in data) {
        // Answered before a record exists: nothing to checkpoint.
        startOpts.slot?.();
        controllers.delete(jobId);
        jobEvents.close(jobId, outcomeOf(data));
        return data;
      }

      records.insert({
        jobId,
        transport: startOpts.transport ?? "rest",
        mode: req.mode ?? "normal",
        status: "planning",
        revision: 0,
        updatedAt: now(),
        data,
        encryptedApiKey:
          req.llmConfig?.apiKey && opts.secretBox
            ? opts.secretBox.seal(req.llmConfig.apiKey)
            : undefined,
      });
      return runSegment(jobId, {
        controller,
        slot: startOpts.slot,
        priority: "normal",
        onCheckpoint: startOpts.onCheckpoint,
      });
    })();

    return { accepted: true, jobId, result };
  }

  function decide(
    jobId: string,
    { revision, decision }: ReviewDecisionRequest
  ): DecisionOutcome {
    const record = records.get(jobId);
    if (!record) {
      return refusal(jobId, "NOT_FOUND", "No paused job with this jobId", 404);
    }
    if (record.status !== "awaiting_review" || controllers.has(jobId)) {
      return refusal(
        jobId,
        "NOT_AWAITING_REVIEW",
        "This job is not waiting for a review",
        409
      );
    }
    if (record.revision !== revision) {
      return refusal(
        jobId,
        "STALE_REVISION",
        `This decision answers revision ${revision}, but the current review is revision ${record.revision}`,
        409
      );
    }

    const data = dataOf(record);
    let next: Partial<JobRecord>;

    if (decision.action === "revise") {
      if (data.reviewRounds >= maxReviewRounds) {
        return refusal(
          jobId,
          "REVIEW_ROUNDS_EXHAUSTED",
          `This job has used all ${maxReviewRounds} revision rounds; approve or edit the outline instead`,
          409
        );
      }
      // Checkpoint 3r (#159): saved before the revision runs, so a crash
      // brings the reviewer back to this outline with their feedback.
      next = {
        status: "revising",
        expiresAt: undefined,
        data: {
          ...data,
          pendingFeedback: decision.feedback,
          reviewRounds: data.reviewRounds + 1,
        },
      };
    } else {
      const shown = data.reviewed ?? data.display!;
      const submitted = decision.action === "edit" ? decision.outline : shown;
      const comparison = compareSubmission(data.display!, submitted);
      if (!comparison.ok) {
        return refusal(jobId, comparison.code, comparison.message, 422);
      }
      // Checkpoint 3. An unchanged resubmission of an already-translated
      // outline keeps its English translation (#159).
      const unchanged = data.reviewed
        ? compareSubmission(data.reviewed, submitted)
        : undefined;
      const reuse =
        data.merged !== undefined &&
        unchanged?.ok === true &&
        unchanged.changed.length === 0;
      const reviewed: JobData = { ...data, reviewed: submitted };
      delete reviewed.pendingFeedback;
      if (!reuse) delete reviewed.merged;
      next = { status: "edits_received", expiresAt: undefined, data: reviewed };
    }

    const written = records.update(jobId, next, {
      status: ["awaiting_review"],
      revision,
    });
    if (!written) {
      return refusal(
        jobId,
        "STALE_REVISION",
        "The review changed while this decision was being applied",
        409
      );
    }

    return {
      accepted: true,
      jobId,
      result: runSegment(jobId, { priority: "high" }),
    };
  }

  function resume(transport: JobTransport): ResumedJob[] {
    const resumed: ResumedJob[] = [];

    for (const record of records.listByTransport(transport)) {
      const { jobId } = record;
      if (jobEvents.state(jobId) !== "unknown") continue;
      const data = dataOf(record);

      // Nothing to resume before the first outline exists: NATS redelivers
      // the unacked request, and a REST requester's connection is gone.
      if (record.status === "planning") {
        records.delete(jobId);
        continue;
      }

      const incompatible =
        data.schema !== JOB_DATA_SCHEMA || data.sandwich !== sandwich;
      const expired =
        record.status === "awaiting_review" &&
        record.expiresAt !== undefined &&
        record.expiresAt <= now();
      let unreadableKey = false;
      try {
        llmConfigOf(record);
      } catch {
        unreadableKey = true;
      }
      if (incompatible || expired || unreadableKey) {
        records.delete(jobId);
        resumed.push({
          jobId,
          result: Promise.resolve(
            expired
              ? failure(
                  jobId,
                  "REVIEW_EXPIRED",
                  "The review time limit passed without a decision",
                  410
                )
              : failure(
                  jobId,
                  "JOB_INTERRUPTED",
                  incompatible
                    ? "The job was checkpointed by an incompatible deployment"
                    : "The job's stored API key cannot be decrypted with the current JOB_ENCRYPTION_KEY",
                  500
                )
          ),
        });
        continue;
      }

      if (record.mode === "normal") {
        // Normal mode resumes case generation from the saved outline — but
        // only where someone can still receive the result (#159).
        if (transport !== "nats") {
          records.delete(jobId);
          continue;
        }
        records.update(jobId, { status: "ready_to_generate" });
        jobEvents.open(jobId);
        resumed.push({
          jobId,
          result: runSegment(jobId, { priority: "high" }),
        });
        continue;
      }

      jobEvents.open(jobId);
      const status: JobStatus = record.status;
      if (status === "outline_ready") {
        // Finish the translation; the job then waits for its review.
        resumed.push({
          jobId,
          result: runSegment(jobId, { priority: "high" }),
        });
        continue;
      }

      if (status !== "awaiting_review") {
        // The reviewer had answered (revising, edits received, translated
        // or generating): back to them, with what they submitted (#159).
        records.update(jobId, reviewPatch(record, data));
      }
      const paused = records.get(jobId)!;
      resumed.push({
        jobId,
        result: Promise.resolve({
          jobId,
          status: "awaiting_review",
          review: reviewOf(paused),
          language: data.language,
        }),
      });
    }

    return resumed;
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
      if (controller) {
        if (controller.signal.aborted) return false;
        controller.abort();
        return true;
      }
      const record = records.get(jobId);
      if (record?.status !== "awaiting_review") return false;
      bus.emit("Generation Cancelled", { jobId });
      endPaused(
        record,
        failure(jobId, "GENERATION_CANCELLED", "Generation was cancelled", 499)
      );
      return true;
    },

    getReview(jobId: string): ReviewPayload | undefined {
      const record = records.get(jobId);
      if (record?.status !== "awaiting_review" || controllers.has(jobId)) {
        return undefined;
      }
      return reviewOf(record);
    },

    decide,
    resume,

    onDetachedOutcome(listener) {
      detachedListeners.add(listener);
      return () => detachedListeners.delete(listener);
    },

    close() {
      clearInterval(sweep);
    },
  };
}
