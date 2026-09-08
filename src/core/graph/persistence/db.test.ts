// Issue 18's direct regression test: `createDb` used to register `SIGINT`,
// `SIGTERM` and `beforeExit` handlers itself, and — because it runs during
// `initGraph`, before any transport starts — its handler's synchronous
// `process.exit(0)` ran first and silently killed the process before a
// transport's own shutdown ever got a turn. Shutdown is now owned entirely
// by the composition root (`src/shutdown.ts`); this asserts `createDb`
// contributes no process listener at all, not just that it fires last.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbHandle } from "./db.js";

describe("createDb registers no process listeners (issue 18)", () => {
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
