import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbHandle } from "@/core/graph/persistence/db.js";
import { createJobRecordRepo, type JobRecordRepo } from "@/core/jobs/repo.js";
import type { JobRecord } from "@/core/jobs/record.js";

let dbHandle: DbHandle;
let tmpDir: string;
let repo: JobRecordRepo;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aetiomed-jobRecordRepo-"));
  dbHandle = createDb(tmpDir);
});

afterAll(() => {
  dbHandle.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  repo = createJobRecordRepo(dbHandle);
});

let idCounter = 0;
function freshRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  idCounter += 1;
  return {
    jobId: `job-${idCounter}`,
    transport: "rest",
    mode: "plan",
    status: "planning",
    revision: 0,
    expiresAt: undefined,
    updatedAt: Date.now(),
    data: { outline: "draft", nested: { a: 1 } },
    encryptedApiKey: undefined,
    ...overrides,
  };
}

describe("insert/get round trip", () => {
  it("round trips a record including nested JSON data", () => {
    const record = freshRecord({
      data: { outline: "hello", n: 42, arr: [1, 2] },
    });
    repo.insert(record);

    const got = repo.get(record.jobId);
    expect(got).toEqual(record);
  });

  it("get returns undefined for an unknown jobId", () => {
    expect(repo.get("does-not-exist")).toBeUndefined();
  });

  it("duplicate insert throws", () => {
    const record = freshRecord();
    repo.insert(record);
    expect(() => repo.insert(record)).toThrow();
  });
});

describe("compare-and-set update", () => {
  it("succeeds and applies the patch, bumping updatedAt when not explicitly given", async () => {
    const record = freshRecord({ status: "planning", revision: 0 });
    repo.insert(record);

    await new Promise((r) => setTimeout(r, 5));
    const ok = repo.update(record.jobId, {
      status: "outline_ready",
      data: { outline: "v2" },
    });
    expect(ok).toBe(true);

    const got = repo.get(record.jobId);
    expect(got?.status).toBe("outline_ready");
    expect(got?.data).toEqual({ outline: "v2" });
    expect(got?.updatedAt).toBeGreaterThan(record.updatedAt);
    // revision untouched since patch didn't set it
    expect(got?.revision).toBe(0);
  });

  it("fails and does not change the row when `expect.status` doesn't match", () => {
    const record = freshRecord({ status: "planning" });
    repo.insert(record);

    const ok = repo.update(
      record.jobId,
      { status: "generating" },
      { status: ["awaiting_review"] }
    );
    expect(ok).toBe(false);

    const got = repo.get(record.jobId);
    expect(got?.status).toBe("planning");
  });

  it("succeeds when `expect.status` matches", () => {
    const record = freshRecord({ status: "awaiting_review" });
    repo.insert(record);

    const ok = repo.update(
      record.jobId,
      { status: "revising" },
      { status: ["awaiting_review", "edits_received"] }
    );
    expect(ok).toBe(true);
    expect(repo.get(record.jobId)?.status).toBe("revising");
  });

  it("fails and does not change the row when `expect.revision` doesn't match", () => {
    const record = freshRecord({ revision: 3 });
    repo.insert(record);

    const ok = repo.update(
      record.jobId,
      { status: "generating" },
      { revision: 2 }
    );
    expect(ok).toBe(false);
    expect(repo.get(record.jobId)?.status).toBe(record.status);
  });

  it("succeeds when `expect.revision` matches", () => {
    const record = freshRecord({ revision: 3 });
    repo.insert(record);

    const ok = repo.update(
      record.jobId,
      { revision: 4, status: "generating" },
      { revision: 3 }
    );
    expect(ok).toBe(true);
    const got = repo.get(record.jobId);
    expect(got?.revision).toBe(4);
    expect(got?.status).toBe("generating");
  });

  it("clears expiresAt when the patch names it as undefined, and leaves it alone when it doesn't", () => {
    const record = freshRecord({ expiresAt: 1_000 });
    repo.insert(record);

    repo.update(record.jobId, { status: "generating" });
    expect(repo.get(record.jobId)?.expiresAt).toBe(1_000);

    repo.update(record.jobId, { expiresAt: undefined });
    expect(repo.get(record.jobId)?.expiresAt).toBeUndefined();
  });

  it("returns false for an unknown jobId", () => {
    expect(repo.update("nope", { status: "generating" })).toBe(false);
  });
});

describe("delete", () => {
  it("removes the row", () => {
    const record = freshRecord();
    repo.insert(record);
    repo.delete(record.jobId);
    expect(repo.get(record.jobId)).toBeUndefined();
  });

  it("is a no-op for an unknown jobId", () => {
    expect(() => repo.delete("nope")).not.toThrow();
  });
});

describe("listByTransport", () => {
  it("returns only records for the requested transport", () => {
    const rest1 = freshRecord({ transport: "rest" });
    const rest2 = freshRecord({ transport: "rest" });
    const nats1 = freshRecord({ transport: "nats" });
    repo.insert(rest1);
    repo.insert(rest2);
    repo.insert(nats1);

    const restJobs = repo.listByTransport("rest").map((r) => r.jobId);
    expect(restJobs).toEqual(
      expect.arrayContaining([rest1.jobId, rest2.jobId])
    );
    expect(restJobs).not.toContain(nats1.jobId);
  });
});

describe("listExpired", () => {
  it("returns only records whose expiresAt is set and <= now", () => {
    const now = Date.now();
    const expired = freshRecord({ expiresAt: now - 1000 });
    const notYetExpired = freshRecord({ expiresAt: now + 100000 });
    const noExpiry = freshRecord({ expiresAt: undefined });
    repo.insert(expired);
    repo.insert(notYetExpired);
    repo.insert(noExpiry);

    const ids = repo.listExpired(now).map((r) => r.jobId);
    expect(ids).toContain(expired.jobId);
    expect(ids).not.toContain(notYetExpired.jobId);
    expect(ids).not.toContain(noExpiry.jobId);
  });
});
