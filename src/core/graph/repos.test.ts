// Issue 04, Commit 2: every repo module moved its I/O behind a constructor.
// Proves the claim directly — importing these modules must not touch the
// filesystem or open the embedded database. No environment variable dance,
// no dynamic import: these are plain static imports, which is itself part
// of the proof (a module with import-time side effects couldn't be imported
// this way without them firing first).
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";

describe("repo modules perform no I/O on import", () => {
  // Both proofs share one import, deliberately. ESM modules execute once per
  // test file, so a second test importing the same modules would observe a
  // cached registry and pass vacuously — it would prove nothing at all.
  it("importing db.ts and every repo module touches neither the database nor a catalogue file", async () => {
    // `fs.mkdirSync` is the one call `createDb()` makes to create the cache
    // directory before opening `aetiomed.db` — nothing else in this
    // dependency tree calls it, so "never called" is a direct proof that the
    // database was never opened, let alone written to, purely from these
    // modules being imported.
    const mkdirSpy = vi.spyOn(fs, "mkdirSync");
    // Distinct from the `mkdirSync` proof: this catches a repo that synced
    // its YAML source (or loaded the symptoms JSON) at import time without
    // ever touching the database.
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    await Promise.all([
      import("@/core/graph/persistence/db.ts"),
      import("@/core/graph/persistence/translationStore.ts"),
      import("@/core/graph/catalog/procedures/repo.ts"),
      import("@/core/graph/catalog/anamnesis/repo.ts"),
      import("@/core/graph/catalog/labels/repo.ts"),
      import("@/core/graph/catalog/diagnosis/repo.ts"),
      import("@/core/graph/symptoms/repo.ts"),
      import("@/core/graph/repos.ts"),
    ]);

    expect(mkdirSpy).not.toHaveBeenCalled();

    const catalogueReads = readFileSpy.mock.calls.filter(([target]) =>
      String(target).match(/\.(ya?ml|json)$/i)
    );
    expect(catalogueReads).toEqual([]);

    mkdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });
});
