// `resolveDiagnosis` through its one function, with the in-memory ICD adapter and a fake LLM port.
import { describe, expect, it, vi } from "vitest";
import type { GraphRuntime, LlmPort } from "@/core/graph/runtime.js";
import { InMemoryDiagnosisCatalog } from "@/adapters/catalog/diagnosis/index.js";
import { createInMemoryIcd } from "@/adapters/icd/inMemory.js";
import { IcdUnavailableError, type IcdPort } from "./icd.js";
import { resolveDiagnosis } from "./resolve.js";

/** Runtime whose translator answers `english` and counts calls. */
function runtimeTranslatingTo(english: string) {
  const structured = vi.fn(async () => ({ diagnosis: english }));
  const runtime = {
    llm: { structured, text: vi.fn() } as unknown as LlmPort,
    catalogs: { diagnosis: new InMemoryDiagnosisCatalog() },
  } as unknown as GraphRuntime;
  return { runtime, structured };
}

const icd = createInMemoryIcd({
  en: [
    {
      code: "BA41",
      title: "Acute myocardial infarction",
      synonyms: ["heart attack"],
    },
    { code: "CA40", title: "Pneumonia", synonyms: [] },
  ],
  de: [
    {
      code: "BA41",
      title: "Akuter Myokardinfarkt",
      synonyms: ["Akuter Herzinfarkt o.n.A."],
    },
    { code: "CA40", title: "Pneumonie", synonyms: [] },
  ],
});

describe("resolveDiagnosis — ICD configured", () => {
  it("an icd resolves to its English title; a sent name is ignored and no LLM runs", async () => {
    const { runtime, structured } = runtimeTranslatingTo("unused");
    await expect(
      resolveDiagnosis({ icd, runtime }, { icd: "CA40", name: "Grippe" }, "de")
    ).resolves.toEqual({ name: "Pneumonia", icd: "CA40" });
    expect(structured).not.toHaveBeenCalled();
  });

  it("an unknown icd is a 400", async () => {
    const { runtime } = runtimeTranslatingTo("unused");
    await expect(
      resolveDiagnosis({ icd, runtime }, { icd: "1A00" }, "en")
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a name hitting a title exactly in the request language needs no LLM", async () => {
    const { runtime, structured } = runtimeTranslatingTo("unused");
    await expect(
      resolveDiagnosis({ icd, runtime }, { name: "  pneumonie " }, "de")
    ).resolves.toEqual({ name: "Pneumonia", icd: "CA40" });
    expect(structured).not.toHaveBeenCalled();
  });

  it("a name hitting a synonym exactly resolves to that entity", async () => {
    const { runtime } = runtimeTranslatingTo("unused");
    await expect(
      resolveDiagnosis({ icd, runtime }, { name: "Heart attack" }, "en")
    ).resolves.toEqual({ name: "Acute myocardial infarction", icd: "BA41" });
  });

  it("a German miss is LLM-translated, then must hit exactly in English", async () => {
    const { runtime, structured } = runtimeTranslatingTo("heart attack");
    await expect(
      resolveDiagnosis({ icd, runtime }, { name: "Herzinfarkt" }, "de")
    ).resolves.toEqual({ name: "Acute myocardial infarction", icd: "BA41" });
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("only a partial hit is a 400, never a fuzzy best match", async () => {
    // "Akuter Herzinfarkt o.n.A." contains "Herzinfarkt"; "myocardial infarction" is part of a title.
    const { runtime } = runtimeTranslatingTo("myocardial infarction");
    await expect(
      resolveDiagnosis({ icd, runtime }, { name: "Herzinfarkt" }, "de")
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("an unreachable ICD surfaces as ICD_UNAVAILABLE", async () => {
    const down: IcdPort = {
      entity: async () => {
        throw new IcdUnavailableError("fetch failed");
      },
      search: async () => {
        throw new IcdUnavailableError("fetch failed");
      },
    };
    const { runtime } = runtimeTranslatingTo("unused");
    await expect(
      resolveDiagnosis({ icd: down, runtime }, { icd: "CA40" }, "en")
    ).rejects.toMatchObject({ code: "ICD_UNAVAILABLE", statusCode: 503 });
  });
});

describe("resolveDiagnosis — no ICD", () => {
  it("an English name passes through, icd kept as an opaque tag", async () => {
    const { runtime, structured } = runtimeTranslatingTo("unused");
    await expect(
      resolveDiagnosis(
        { icd: undefined, runtime },
        { name: "Influenza", icd: "1E32" },
        "en"
      )
    ).resolves.toEqual({ name: "Influenza", icd: "1E32" });
    expect(structured).not.toHaveBeenCalled();
  });

  it("a curated translation resolves without the LLM", async () => {
    const { runtime, structured } = runtimeTranslatingTo("unused");
    runtime.catalogs.diagnosis.saveTranslations({ Influenza: "Grippe" }, "de");
    await expect(
      resolveDiagnosis({ icd: undefined, runtime }, { name: "Grippe" }, "de")
    ).resolves.toEqual({ name: "Influenza", icd: undefined });
    expect(structured).not.toHaveBeenCalled();
  });

  it("a miss calls the LLM once, then the store answers", async () => {
    const { runtime, structured } = runtimeTranslatingTo("Influenza");
    const resolve = () =>
      resolveDiagnosis({ icd: undefined, runtime }, { name: "Grippe" }, "de");
    await resolve();
    await expect(resolve()).resolves.toMatchObject({ name: "Influenza" });
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("an icd without a name is a 400", async () => {
    const { runtime } = runtimeTranslatingTo("unused");
    await expect(
      resolveDiagnosis({ icd: undefined, runtime }, { icd: "CA40" }, "en")
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
