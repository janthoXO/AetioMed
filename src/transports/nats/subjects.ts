// The NATS subject and stream layout (#142). Split on **durability**, not on
// feature: a JetStream stream's retention applies to everything its subject
// filter captures, which is exactly how the old `cases` stream (`cases.>`,
// workqueue) swallowed results and cancels with no consumer to ever ack
// them. See docs/issues/17-transport-parity.md §D6.
import { RetentionPolicy, StorageType } from "@nats-io/jetstream";
import type { JobEventType } from "@/core/jobEvents/index.js";

/** JetStream, workqueue: a submitted job, taken by exactly one worker. */
export const REQUEST_SUBJECT = "cases.request.generate";

/**
 * JetStream, limits: a job's result, on its own subject so a client filters
 * to its own result, with replay, for `RESULT_MAX_AGE_MS`. This retention is
 * what makes "NATS provides the persistence" true — on workqueue the first
 * ack would destroy it for everyone else.
 */
export const resultSubject = (jobId: string) => `cases.result.${jobId}`;

/** Core NATS, fan-out, ephemeral: one subject token per job event type (#144). */
export const progressSubject = (jobId: string, type: JobEventType) =>
  `cases.progress.${jobId}.${type}`;

/**
 * Core NATS request/reply, answered only by the replica that owns the job
 * (it subscribes for exactly as long as the job runs). An unknown job has no
 * subscriber, so a request gets NATS's own "no responders" — instantly, and
 * never a wrong `false` from a replica that merely does not own it.
 */
export const cancelSubject = (jobId: string) => `cases.cancel.${jobId}`;

/**
 * Core NATS request/reply, the `@nats-io/services` meta service (#144). One
 * subject per REST read-only counterpart — see `metaService.ts`.
 */
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

export const STREAMS = [REQUESTS_STREAM, RESULTS_STREAM] as const;

/** The pre-#142 stream. Its `cases.>` filter overlaps both new streams. */
export const LEGACY_STREAM = "cases";

export const REQUEST_CONSUMER = "case-request-worker";

/**
 * Short, because the worker extends it with `msg.working()` while a
 * generation runs: a crashed replica's job is redelivered within a minute,
 * instead of after the old flat ten.
 */
export const REQUEST_ACK_WAIT_MS = 60 * 1000;
export const WORKING_INTERVAL_MS = 20 * 1000;

/**
 * Whether a NATS subject filter (`*` = one token, `>` = one or more trailing
 * tokens) captures `subject`. Used to prove the streams never capture each
 * other's — or any other channel's — traffic.
 */
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
