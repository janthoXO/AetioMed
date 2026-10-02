// NATS subject and stream layout. Split on durability, not feature: stream
// retention applies to everything its subject filter captures.
import { RetentionPolicy, StorageType } from "@nats-io/jetstream";
import type { JobEventType } from "@/core/jobEvents/index.js";

/** JetStream, workqueue: a submitted job, taken by exactly one worker. */
export const REQUEST_SUBJECT = "cases.request.generate";

/**
 * JetStream, limits: job result on own subject, replayable for
 * `RESULT_MAX_AGE_MS`. Not workqueue: first ack would destroy it for others.
 */
export const resultSubject = (jobId: string) => `cases.result.${jobId}`;

/** Core NATS, fan-out, ephemeral: one subject token per job event type. */
export const progressSubject = (jobId: string, type: JobEventType) =>
  `cases.progress.${jobId}.${type}`;

/**
 * Core NATS request/reply, answered only by owning replica (subscribed while
 * job runs). Unknown job → "no responders", never a wrong `false`.
 */
export const cancelSubject = (jobId: string) => `cases.cancel.${jobId}`;

/** Every progress event of one job; remote observer subscribes here. */
export const progressWildcard = (jobId: string) => `cases.progress.${jobId}.>`;

/**
 * JetStream, limits: job plan on own subject, replayable (like
 * `resultSubject`). Published in both modes: plan-mode ends with it,
 * normal-mode emits it before the result.
 */
export const planSubject = (jobId: string) => `cases.plan.${jobId}`;

/**
 * Core NATS request/reply → `{ state: "active" } | { state: "terminal",
 * complete }`, answered by owner while job runs and through tombstone
 * window. "No responders" = unknown (404), vs finished (`event: complete`).
 */
export const statusSubject = (jobId: string) => `cases.status.${jobId}`;

/** Core NATS request/reply meta service; one subject per REST read-only route. See `metaService.ts`. */
export const CATALOG_DIAGNOSIS_SUBJECT = "catalog.diagnosis";
export const CATALOG_PROCEDURES_SUBJECT = "catalog.procedures";
export const META_FEATURES_SUBJECT = "meta.features";
export const META_ALLOWED_LLMS_SUBJECT = "meta.allowedLlms";
export const META_GRAPH_SUBJECT = "meta.graph";

export const RESULT_MAX_AGE_MS = 60 * 60 * 1000;

const nanos = (ms: number) => ms * 1_000_000;

export const REQUESTS_STREAM = {
  name: "CASE_REQUESTS",
  subjects: ["cases.request.*"],
  retention: RetentionPolicy.Workqueue,
  storage: StorageType.File,
  duplicate_window: nanos(2 * 60 * 1000),
} as const;

export const RESULTS_STREAM = {
  name: "CASE_RESULTS",
  subjects: ["cases.result.*"],
  retention: RetentionPolicy.Limits,
  storage: StorageType.File,
  max_age: nanos(RESULT_MAX_AGE_MS),
  duplicate_window: nanos(2 * 60 * 1000),
} as const;

export const PLANS_STREAM = {
  name: "CASE_PLANS",
  subjects: ["cases.plan.*"],
  retention: RetentionPolicy.Limits,
  storage: StorageType.File,
  max_age: nanos(RESULT_MAX_AGE_MS),
  duplicate_window: nanos(2 * 60 * 1000),
} as const;

export const STREAMS = [REQUESTS_STREAM, RESULTS_STREAM, PLANS_STREAM] as const;

/** Legacy stream. Its `cases.>` filter overlaps every current stream. */
export const LEGACY_STREAM = "cases";

export const REQUEST_CONSUMER = "case-request-worker";

/** Short: worker extends via `msg.working()` mid-generation; crashed replica's job redelivers within a minute. */
export const REQUEST_ACK_WAIT_MS = 60 * 1000;
export const WORKING_INTERVAL_MS = 20 * 1000;

/**
 * Max runs per request. Ack only after publish, so each redelivery = crash
 * or missed heartbeat. Consumer delivers once more, to publish the failure.
 */
export const REQUEST_MAX_ATTEMPTS = 3;

/** Whether NATS filter (`*` one token, `>` one+ trailing) captures `subject`. */
export function subjectMatches(filter: string, subject: string): boolean {
  const f = filter.split(".");
  const s = subject.split(".");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (f[i] !== "*" && f[i] !== s[i]) return false;
  }
  return f.length === s.length;
}
