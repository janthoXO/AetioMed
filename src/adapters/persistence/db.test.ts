// `createDb` must register no process listeners (SIGINT/SIGTERM/beforeExit):
// its synchronous `process.exit(0)` would run before transports shut down.
// Shutdown belongs to the composition root (`src/shutdown.ts`).
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbHandle } from "./db.js";

describe("createDb registers no process listeners", () => {
  let dbHandle: DbHandle | undefined;
  let tmpDir: string | undefined;

  afterAll(() => {
    dbHandle?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("leaves SIGINT/SIGTERM/beforeExit listener counts unchanged", () => {
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      beforeExit: process.listenerCount("beforeExit"),
    };

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aetiomed-db-"));
    dbHandle = createDb(tmpDir);

    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit);
  });
});

describe("syncSource treats a missing file as empty", () => {
  it("ingests `{}` once the file is removed, so a stale list can be cleared", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aetiomed-sync-"));
    const handle = createDb(dir);
    const file = path.join(dir, "list.yml");
    const ingested: unknown[] = [];
    const sync = () =>
      handle.syncSource("list", file, (parsed) => ingested.push(parsed));

    try {
      fs.writeFileSync(file, "categories: [a]\n");
      expect(sync()).toBe(true);
      fs.rmSync(file);
      expect(sync()).toBe(true);
      expect(sync()).toBe(false); // missing again: unchanged
      expect(ingested).toEqual([{ categories: ["a"] }, {}]);
    } finally {
      handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
