// Mapped-symptoms provider: joined names when data exists, `undefined` otherwise. Never calls the LLM, never touches the cache.
import { describe, expect, it } from "vitest";
import { createMappedSymptomProvider } from "./mappedSymptoms.js";
import type { SymptomMapping } from "@/core/graph/02-plan/01-basis/ports.js";
import type { Symptom } from "@/core/graph/02-plan/01-basis/symptom.js";
import type { BasisQuery } from "@/core/graph/02-plan/01-basis/ports.js";

/** The provider takes only the floor, so it cannot touch the cache by construction. */
function makeFakeSymptomsRepo(
  mappedByIcd: Record<string, Symptom[]>
): SymptomMapping {
  return {
    SymptomsRelatedToDiagnosisIcd: (icd) => mappedByIcd[icd] ?? [],
  };
}

const query: BasisQuery = {
  diagnosis: { name: "Influenza", icd: "1E32" },
  difficulty: "medium",
};

describe("createMappedSymptomProvider", () => {
  it("id is 'mapped-symptoms'", () => {
    const provider = createMappedSymptomProvider(makeFakeSymptomsRepo({}));
    expect(provider.id).toBe("mapped-symptoms");
  });

  it("mapping data for the ICD code: returns names joined by ', '", async () => {
    const repo = makeFakeSymptomsRepo({
      "1E32": [{ name: "Fever" }, { name: "Cough" }],
    });
    const provider = createMappedSymptomProvider(repo);

    expect(await provider.fetch(query)).toBe("Fever, Cough");
  });

  it("no ICD code: undefined", async () => {
    const provider = createMappedSymptomProvider(makeFakeSymptomsRepo({}));

    expect(
      await provider.fetch({
        diagnosis: { name: "Unspecified illness" },
        difficulty: "medium",
      })
    ).toBeUndefined();
  });

  it("ICD code with no mapping data: undefined", async () => {
    const provider = createMappedSymptomProvider(makeFakeSymptomsRepo({}));

    expect(await provider.fetch(query)).toBeUndefined();
  });
});
