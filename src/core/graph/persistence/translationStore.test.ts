// The embedded database is now injectable (issue 04): construct a `DbHandle`
// directly over a temporary directory, no environment-variable dance and no
// dynamic import required.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { ForeignLanguage } from "@/core/graph/models/Language.js";
import { createDb, type DbHandle } from "@/core/graph/persistence/db.js";
import { createTranslationStore } from "@/core/graph/persistence/translationStore.js";
import { translation } from "@/core/graph/persistence/schema.js";

let dbHandle: DbHandle;
let tmpDir: string;

const LANG: ForeignLanguage = "German";

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aetiomed-translationStore-"));
  dbHandle = createDb(tmpDir);
});

afterAll(() => {
  dbHandle.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let domainCounter = 0;
function freshStore(opts: { yamlFile?: string } = {}) {
  domainCounter += 1;
  return createTranslationStore(dbHandle, {
    name: `TestDomain${domainCounter}`,
    yamlFile: opts.yamlFile,
    // Keep tests fast: small retry count, zero backoff.
    retries: 2,
    retryBaseDelayMs: 0,
  });
}

describe("translateMissing concurrency", () => {
  it("dedups per key: two overlapping requests missing {A,B} and {B,C} call generate once for B, and both get the same value", async () => {
    const store = freshStore();

    const generate = vi.fn(async (missing: string[]) => {
      const out: Record<string, string> = {};
      for (const key of missing) out[key] = `${key}-translated`;
      return out;
    });

    const [result1, result2] = await Promise.all([
      store.translateMissing(["A", "B"], LANG, generate),
      store.translateMissing(["B", "C"], LANG, generate),
    ]);

    const callsContainingB = generate.mock.calls.filter((call) =>
      (call[0] as string[]).includes("B")
    );
    expect(callsContainingB).toHaveLength(1);

    expect(result1["B"]).toBe(result2["B"]);
    expect(result1["A"]).toBe("A-translated");
    expect(result2["C"]).toBe("C-translated");
  });
});

describe("translateMissing retry", () => {
  it("fails twice then succeeds: every waiter receives the success and generate is called 3 times", async () => {
    const store = freshStore();
    let calls = 0;
    const generate = vi.fn(async (missing: string[]) => {
      calls += 1;
      if (calls < 3) throw new Error("transient failure");
      const out: Record<string, string> = {};
      for (const key of missing) out[key] = `${key}-ok`;
      return out;
    });

    const [r1, r2] = await Promise.all([
      store.translateMissing(["X"], LANG, generate),
      store.translateMissing(["X"], LANG, generate),
    ]);

    expect(generate).toHaveBeenCalledTimes(3);
    expect(r1["X"]).toBe("X-ok");
    expect(r2["X"]).toBe("X-ok");
  });
});

describe("translateMissing failure", () => {
  it("always failing generate: waiters settle without a value, in-flight is cleared, and a subsequent call retries fresh", async () => {
    const store = freshStore();
    const failing = vi.fn(async () => {
      throw new Error("permanent failure");
    });

    const [r1, r2] = await Promise.all([
      store.translateMissing(["Y"], LANG, failing),
      store.translateMissing(["Y"], LANG, failing),
    ]);

    expect(r1["Y"]).toBeUndefined();
    expect(r2["Y"]).toBeUndefined();

    const failingCallCountBefore = failing.mock.calls.length;
    expect(failingCallCountBefore).toBeGreaterThan(0);

    // A fresh call after the failure must not inherit a cached rejection —
    // it should call generate again rather than resolving/rejecting instantly
    // from a stale in-flight entry.
    const succeeding = vi.fn(async (missing: string[]) => {
      const out: Record<string, string> = {};
      for (const key of missing) out[key] = `${key}-recovered`;
      return out;
    });
    const r3 = await store.translateMissing(["Y"], LANG, succeeding);
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(r3["Y"]).toBe("Y-recovered");
  });
});

describe("translateMissing partial batch success", () => {
  it("resolves the 2 keys that came back and only retries the still-missing third", async () => {
    const store = freshStore();
    const calls: string[][] = [];
    const generate = vi.fn(async (missing: string[]) => {
      calls.push([...missing]);
      const out: Record<string, string> = {};
      for (const key of missing) {
        if (key !== "P3") out[key] = `${key}-done`;
      }
      return out;
    });

    const result = await store.translateMissing(
      ["P1", "P2", "P3"],
      LANG,
      generate
    );

    expect(result["P1"]).toBe("P1-done");
    expect(result["P2"]).toBe("P2-done");
    // P3 never comes back within the retry budget — permanently missing.
    expect(result["P3"]).toBeUndefined();

    expect(calls[0]).toEqual(["P1", "P2", "P3"]);
    // Every subsequent attempt must only carry the still-missing key.
    for (const call of calls.slice(1)) {
      expect(call).toEqual(["P3"]);
    }
  });
});

describe("translateMissing fallback at the call site", () => {
  it("a permanently failing fill still yields a usable result via the English-key fallback", async () => {
    const store = freshStore();
    const failing = vi.fn(async () => {
      throw new Error("permanent failure");
    });

    const englishKey = "Chief Complaint";
    const translations = await store.translateMissing(
      [englishKey],
      LANG,
      failing
    );

    // The call site (the `tracing` module's label localization) does exactly
    // this: fall back to the English key when no translation is present.
    const resolved = translations[englishKey] ?? englishKey;
    expect(resolved).toBe(englishKey);
  });
});

describe("save() first-writer-wins", () => {
  it("a second write of the same key with a different value does not overwrite the first", () => {
    const store = freshStore();

    const first = store.save({ Term: "first-value" }, LANG);
    expect(first["Term"]).toBe("first-value");

    const second = store.save({ Term: "second-value" }, LANG);
    expect(second["Term"]).toBe("first-value");

    expect(store.getFromEnglish("Term", LANG)).toBe("first-value");
  });
});

describe("provenance", () => {
  it("a YAML-synced row is curated, a runtime-filled row is generated, and a resync overwrites a generated row back to curated", async () => {
    domainCounter += 1;
    const domainName = `ProvenanceDomain${domainCounter}`;
    const yamlPath = path.join(tmpDir, `${domainName}.yml`);

    fs.writeFileSync(
      yamlPath,
      `German:\n  "Curated Term": "Kuratierter Begriff"\n`
    );

    const store1 = createTranslationStore(dbHandle, {
      name: domainName,
      yamlFile: yamlPath,
      retries: 2,
      retryBaseDelayMs: 0,
    });

    const curatedRow = () =>
      dbHandle.db
        .select({
          source: translation.source,
          translated: translation.translated,
        })
        .from(translation)
        .where(
          and(
            eq(translation.domain, domainName),
            eq(translation.lang, LANG),
            eq(translation.english, "Curated Term")
          )
        )
        .get();

    expect(curatedRow()?.source).toBe("curated");

    // Runtime fill for a different key.
    store1.save({ "Runtime Term": "Laufzeitbegriff" }, LANG);

    const generatedRowBefore = dbHandle.db
      .select({
        source: translation.source,
        translated: translation.translated,
      })
      .from(translation)
      .where(
        and(
          eq(translation.domain, domainName),
          eq(translation.lang, LANG),
          eq(translation.english, "Runtime Term")
        )
      )
      .get();
    expect(generatedRowBefore?.source).toBe("generated");
    expect(generatedRowBefore?.translated).toBe("Laufzeitbegriff");

    // Update the YAML to also curate "Runtime Term" and re-sync (new store
    // construction, same domain name -> same `_meta` source key, changed
    // file content -> triggers a re-parse).
    fs.writeFileSync(
      yamlPath,
      `German:\n  "Curated Term": "Kuratierter Begriff"\n  "Runtime Term": "Kuratierte Version"\n`
    );

    createTranslationStore(dbHandle, {
      name: domainName,
      yamlFile: yamlPath,
      retries: 2,
      retryBaseDelayMs: 0,
    });

    const generatedRowAfter = dbHandle.db
      .select({
        source: translation.source,
        translated: translation.translated,
      })
      .from(translation)
      .where(
        and(
          eq(translation.domain, domainName),
          eq(translation.lang, LANG),
          eq(translation.english, "Runtime Term")
        )
      )
      .get();

    expect(generatedRowAfter?.source).toBe("curated");
    expect(generatedRowAfter?.translated).toBe("Kuratierte Version");
  });
});
