// `IcdPort` over a fake `fetch` (shapes copied from a live `whoicd/icd-api:2.6.0`) and a temp DB.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbHandle } from "@/adapters/persistence/db.js";
import { IcdUnavailableError } from "@/core/diagnosis/icd.js";
import { createIcdClient } from "./client.js";
import { createIcdPort } from "./port.js";
import { createInMemoryIcd } from "./inMemory.js";

let dbHandle: DbHandle;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aetiomed-icdPort-"));
  dbHandle = createDb(tmpDir);
});

afterAll(() => {
  dbHandle.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE = "http://icd/icd/release/11/2026-01/mms";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Routes by URL; records every call as `<url> <Accept-Language>`. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const lang = (init.headers as Record<string, string>)["Accept-Language"];
    calls.push(`${url} ${lang}`);
    const route = routes[url.split("?")[0]!];
    return route ? route() : new Response('"not found"', { status: 404 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function port(fetchFn: typeof fetch, release = "2026-01") {
  return createIcdPort(
    createIcdClient({ url: "http://icd", release, fetch: fetchFn }),
    dbHandle
  );
}

const pneumonia = {
  [`${BASE}/codeinfo/CA40`]: () =>
    json({
      code: "CA40",
      stemId: "http://id.who.int/icd/release/11/2026-01/mms/142052508",
    }),
  [`${BASE}/142052508`]: () =>
    json({ code: "CA40", title: { "@language": "en", "@value": "Pneumonia" } }),
};

describe("createIcdPort.entity", () => {
  it("resolves codeinfo then stemId, and caches per (release, code, lang)", async () => {
    const { fetchFn, calls } = fakeFetch(pneumonia);
    const icd = port(fetchFn);

    expect(await icd.entity("CA40", "en")).toEqual({
      code: "CA40",
      title: "Pneumonia",
    });
    expect(calls).toEqual([`${BASE}/codeinfo/CA40 en`, `${BASE}/142052508 en`]);

    await icd.entity("CA40", "en");
    expect(calls).toHaveLength(2); // cache hit

    await icd.entity("CA40", "de"); // other language = miss
    await port(fetchFn, "2025-01").entity("CA40", "en"); // other release = miss (404 here)
    expect(calls).toHaveLength(5);
  });

  it("titles a cluster after its stem, the added codes in parentheses", async () => {
    const { fetchFn, calls } = fakeFetch({
      [`${BASE}/codeinfo/CA40.Z%26XB22`]: () =>
        json({
          code: "CA40.Z&XB22",
          stemId:
            "http://id.who.int/icd/release/11/2026-01/mms/142052508/unspecified",
          stemCode: "CA40.Z",
          causality: ["XB22"],
        }),
      [`${BASE}/142052508/unspecified`]: () =>
        json({
          title: { "@value": "Pneumonia, organism unspecified" },
        }),
      [`${BASE}/codeinfo/XB22`]: () =>
        json({
          code: "XB22",
          stemId: "http://id.who.int/icd/release/11/2026-01/mms/339929010",
        }),
      [`${BASE}/339929010`]: () =>
        json({ title: { "@value": "Community acquired" } }),
    });

    expect(await port(fetchFn).entity("CA40.Z&XB22", "en")).toEqual({
      code: "CA40.Z&XB22",
      title: "Pneumonia, organism unspecified (Community acquired)",
    });
    expect(calls).toContain(`${BASE}/codeinfo/CA40.Z%26XB22 en`);
  });

  it("rejects a cluster codeinfo changes (second value on a single-value axis)", async () => {
    const { fetchFn } = fakeFetch({
      [`${BASE}/codeinfo/CA40.Z%26XB22%26XB25`]: () =>
        json({
          code: "CA40.Z&XB25",
          stemId:
            "http://id.who.int/icd/release/11/2026-01/mms/142052508/unspecified",
        }),
    });
    expect(
      await port(fetchFn).entity("CA40.Z&XB22&XB25", "en")
    ).toBeUndefined();
  });

  it("returns undefined for a code the release does not have", async () => {
    const { fetchFn } = fakeFetch({});
    expect(await port(fetchFn).entity("ZZ99", "en")).toBeUndefined();
  });

  it("maps a 5xx or network failure to IcdUnavailableError", async () => {
    const down = fakeFetch({
      [`${BASE}/codeinfo/BA41`]: () => new Response("boom", { status: 502 }),
    });
    await expect(port(down.fetchFn).entity("BA41", "en")).rejects.toThrow(
      IcdUnavailableError
    );

    const unreachable = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(port(unreachable).entity("BA41", "en")).rejects.toThrow(
      IcdUnavailableError
    );
  });

  it("lets a request abort through untouched", async () => {
    const aborted = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    await expect(port(aborted).entity("BA42", "en")).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("createIcdPort.search", () => {
  it("keeps coded hits (clusters too) with their matched synonyms, drops blocks", async () => {
    const { fetchFn, calls } = fakeFetch({
      [`${BASE}/search`]: () =>
        json({
          destinationEntities: [
            {
              theCode: "BA41",
              title: "Acute myocardial infarction",
              matchingPVs: [
                { propertyId: "Synonym", label: "heart attack" },
                { propertyId: "Title", label: "Some descendant" },
              ],
            },
            { theCode: "", title: "Diabetes mellitus" },
            {
              theCode: "DB10.Y&XT1L",
              title: "Other specified appendicitis [Subacute]",
            },
          ],
        }),
    });

    expect(await port(fetchFn).search("heart attack", "en")).toEqual([
      {
        code: "BA41",
        title: "Acute myocardial infarction",
        synonyms: ["heart attack"],
      },
      {
        code: "DB10.Y&XT1L",
        title: "Other specified appendicitis [Subacute]",
        synonyms: [],
      },
    ]);
    expect(calls[0]).toContain("q=heart+attack");
    expect(calls[0]).toContain("medicalCodingMode=false");
  });
});

describe("createInMemoryIcd", () => {
  it("serves entity and search from fixed entries", async () => {
    const icd = createInMemoryIcd({
      en: [
        {
          code: "BA41",
          title: "Acute myocardial infarction",
          synonyms: ["heart attack"],
        },
      ],
    });
    expect(await icd.entity("BA41", "en")).toEqual({
      code: "BA41",
      title: "Acute myocardial infarction",
    });
    expect(await icd.entity("BA41", "de")).toBeUndefined();
    expect((await icd.search("heart", "en")).map((h) => h.code)).toEqual([
      "BA41",
    ]);
  });
});
