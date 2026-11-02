import type { SymptomMapping } from "@/core/graph/02-plan/01-basis/ports.js";
import type { MedicalBasisProvider } from "@/core/graph/02-plan/01-basis/ports.js";

/** Mapped symptoms for the diagnosis's ICD code. Nothing without an ICD code or mapping data; never generated content. */
export function createMappedSymptomProvider(
  symptomMapping: SymptomMapping
): MedicalBasisProvider {
  return {
    id: "mapped-symptoms",
    description: "Typical symptoms (curated ICD → symptom mapping)",
    async fetch(query) {
      const icd = query.diagnosis.icd;
      const symptoms = icd
        ? symptomMapping.SymptomsRelatedToDiagnosisIcd(icd)
        : [];
      return symptoms.map((s) => s.name).join(", ") || undefined;
    },
  };
}
