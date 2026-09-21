/**
 * Job checkpoint types (#159, plan mode). A `JobRecord` is the durable row
 * in `job_record` (`persistence/schema.ts`) that lets a paused or in-flight
 * job survive a process restart — see `repo.ts` for the CAS-based store.
 */
export type JobTransport = "rest" | "nats";
import type { RunMode } from "../graph/models/RunMode.js";
export type { RunMode };
export type JobStatus =
  | "planning"
  | "outline_ready"
  | "awaiting_review"
  | "revising"
  | "edits_received"
  | "ready_to_generate"
  | "generating";

/**
 * Opaque JSON payload owned by the job service — the repo never interprets
 * it, only JSON-encodes/decodes and fully replaces it on write.
 */
export type JobRecordData = Record<string, unknown>;

export interface JobRecord {
  jobId: string;
  transport: JobTransport;
  mode: RunMode;
  status: JobStatus;
  revision: number;
  expiresAt?: number | undefined;
  updatedAt: number;
  data: JobRecordData;
  encryptedApiKey?: string | undefined;
}
