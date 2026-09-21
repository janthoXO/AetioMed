import type { JobRecordRepo } from "./repo.js";
import type { JobRecord } from "./record.js";

/**
 * The same compare-and-set contract as `createJobRecordRepo`, held in
 * memory — for tests, and for a service constructed without a database
 * (checkpoints then do not survive a restart). Records are deep-copied in
 * and out, as a real store would round-trip them through JSON.
 */
export function createInMemoryJobRecordRepo(): JobRecordRepo {
  const rows = new Map<string, JobRecord>();
  const copy = (record: JobRecord): JobRecord => structuredClone(record);

  return {
    insert(record) {
      if (rows.has(record.jobId)) {
        throw new Error(`job_record ${record.jobId} already exists`);
      }
      rows.set(record.jobId, copy(record));
    },
    get(jobId) {
      const row = rows.get(jobId);
      return row && copy(row);
    },
    update(jobId, patch, expect) {
      const row = rows.get(jobId);
      if (!row) return false;
      if (expect?.status && !expect.status.includes(row.status)) return false;
      if (expect?.revision !== undefined && row.revision !== expect.revision) {
        return false;
      }
      const next = { ...row, ...structuredClone(patch) };
      next.updatedAt = patch.updatedAt ?? Date.now();
      rows.set(jobId, next);
      return true;
    },
    delete(jobId) {
      rows.delete(jobId);
    },
    listByTransport(transport) {
      return [...rows.values()]
        .filter((r) => r.transport === transport)
        .map(copy);
    },
    listExpired(now) {
      return [...rows.values()]
        .filter((r) => r.expiresAt !== undefined && r.expiresAt <= now)
        .map(copy);
    },
  };
}
