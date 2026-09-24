// UMLS-only provider: joined names when data exists, `undefined` otherwise. Never calls the LLM, never touches the cache.
import { describe, expect, it } from "vitest";
import { createUmlsSymptomProvider } from "./umlsSymptoms.js";
import type { SymptomsRepo } from "@/core/graph/symptoms/repo.js";
import type { Symptom } from "@/core/graph/models/Symptom.js";
import type { BasisQuery } from "../ports.js";

/** Cache methods throw: proves the UMLS-only provider never touches the cache. */
function makeFakeSymptomsRepo(
  umlsByIcd: Record<string, Symptom[]>
): SymptomsRepo {
  return {
    SymptomsRelatedToDiagnosisIcd: (icd) => umlsByIcd[icd] ?? [],
    getCachedSymptoms: () => {
      throw new Error("umlsSymptoms.test: the cache must not be read here.");
    },
    saveCachedSymptoms: () => {
      throw new Error("umlsSymptoms.test: the cache must not be written here.");
    },
  };
}

const query: BasisQuery = {
  diagnosis: { name: "Influenza", icd: "1E32" },
  difficulty: "medium",
};

describe("createUmlsSymptomProvider", () => {
  it("id is 'umls-symptoms'", () => {
    const provider = createUmlsSymptomProvider(makeFakeSymptomsRepo({}));
    expect(provider.id).toBe("umls-symptoms");
  });

  it("UMLS data for the ICD code: returns names joined by ', '", async () => {
    const repo = makeFakeSymptomsRepo({
      "1E32": [{ name: "Fever" }, { name: "Cough" }],
    });
    const provider = createUmlsSymptomProvider(repo);

    expect(await provider.fetch(query)).toBe("Fever, Cough");
  });

  it("no ICD code: undefined", async () => {
    const provider = createUmlsSymptomProvider(makeFakeSymptomsRepo({}));

    expect(
      await provider.fetch({
        diagnosis: { name: "Unspecified illness" },
        difficulty: "medium",
      })
    ).toBeUndefined();
  });

  it("ICD code with no UMLS data: undefined", async () => {
    const provider = createUmlsSymptomProvider(makeFakeSymptomsRepo({}));

    expect(await provider.fetch(query)).toBeUndefined();
  });
});
