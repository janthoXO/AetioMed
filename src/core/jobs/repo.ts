import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DbHandle } from "../graph/persistence/db.js";
import { jobRecord } from "../graph/persistence/schema.js";
import type {
  JobRecord,
  JobRecordData,
  JobStatus,
  JobTransport,
} from "./record.js";

type Row = typeof jobRecord.$inferSelect;

function toRecord(row: Row): JobRecord {
  return {
    jobId: row.jobId,
    transport: row.transport,
    mode: row.mode,
    status: row.status as JobStatus,
    revision: row.revision,
    expiresAt: row.expiresAt ?? undefined,
    updatedAt: row.updatedAt,
    data: JSON.parse(row.data) as JobRecordData,
    encryptedApiKey: row.encryptedApiKey ?? undefined,
  };
}

export interface JobRecordRepo {
  /** Throws if `record.jobId` already exists. */
  insert(record: JobRecord): void;
  get(jobId: string): JobRecord | undefined;
  /**
   * Compare-and-set update: a single `UPDATE ... WHERE job_id = ? [AND
   * status IN (...)] [AND revision = ?]`. `data`, when given, fully
   * replaces the stored JSON. `updated_at` is always set to `Date.now()`
   * unless `patch.updatedAt` is given explicitly. Returns whether a row was
   * actually changed (false means either the job doesn't exist or `expect`
   * didn't hold).
   */
  update(
    jobId: string,
    patch: Partial<Omit<JobRecord, "jobId">>,
    expect?: { status?: JobStatus[]; revision?: number }
  ): boolean;
  delete(jobId: string): void;
  listByTransport(transport: JobTransport): JobRecord[];
  listExpired(now: number): JobRecord[];
}

/**
 * Job checkpoint store (#159, plan mode) — the compare-and-set persistence
 * layer for `job_record`. Follows the `createXxx(handle)` repo-layer
 * convention (`persistence/db.ts`'s `DbHandle`, see CLAUDE.md's Repo Layer
 * section): no I/O happens on import, only when a query/write method is
 * called.
 */
export function createJobRecordRepo(handle: DbHandle): JobRecordRepo {
  const { db } = handle;

  function insert(record: JobRecord): void {
    db.insert(jobRecord)
      .values({
        jobId: record.jobId,
        transport: record.transport,
        mode: record.mode,
        status: record.status,
        revision: record.revision,
        expiresAt: record.expiresAt ?? null,
        updatedAt: record.updatedAt,
        data: JSON.stringify(record.data),
        encryptedApiKey: record.encryptedApiKey ?? null,
      })
      .run();
  }

  function get(jobId: string): JobRecord | undefined {
    const row = db
      .select()
      .from(jobRecord)
      .where(eq(jobRecord.jobId, jobId))
      .get();
    return row ? toRecord(row) : undefined;
  }

  function update(
    jobId: string,
    patch: Partial<Omit<JobRecord, "jobId">>,
    expect?: { status?: JobStatus[]; revision?: number }
  ): boolean {
    const set: Partial<typeof jobRecord.$inferInsert> = {};
    if (patch.transport !== undefined) set.transport = patch.transport;
    if (patch.mode !== undefined) set.mode = patch.mode;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.revision !== undefined) set.revision = patch.revision;
    // `in`, not `!== undefined`: a patch that names `expiresAt` or
    // `encryptedApiKey` with an undefined value clears it (a resumed job no
    // longer has a review deadline).
    if ("expiresAt" in patch) set.expiresAt = patch.expiresAt ?? null;
    if (patch.data !== undefined) set.data = JSON.stringify(patch.data);
    if ("encryptedApiKey" in patch)
      set.encryptedApiKey = patch.encryptedApiKey ?? null;
    set.updatedAt = patch.updatedAt ?? Date.now();

    const conditions: SQL[] = [eq(jobRecord.jobId, jobId)];
    if (expect?.status)
      conditions.push(inArray(jobRecord.status, expect.status));
    if (expect?.revision !== undefined)
      conditions.push(eq(jobRecord.revision, expect.revision));

    const result = db
      .update(jobRecord)
      .set(set)
      .where(and(...conditions))
      .run();

    return result.changes > 0;
  }

  function del(jobId: string): void {
    db.delete(jobRecord).where(eq(jobRecord.jobId, jobId)).run();
  }

  function listByTransport(transport: JobTransport): JobRecord[] {
    return db
      .select()
      .from(jobRecord)
      .where(eq(jobRecord.transport, transport))
      .all()
      .map(toRecord);
  }

  function listExpired(now: number): JobRecord[] {
    return db
      .select()
      .from(jobRecord)
      .where(and(isNotNull(jobRecord.expiresAt), lte(jobRecord.expiresAt, now)))
      .all()
      .map(toRecord);
  }

  return {
    insert,
    get,
    update,
    delete: del,
    listByTransport,
    listExpired,
  };
}
