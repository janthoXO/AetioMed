import type { SymptomsRepo } from "@/core/graph/symptoms/repo.js";
import type { MedicalBasisProvider } from "../ports.js";

/** UMLS symptoms for the diagnosis's ICD code. Nothing without an ICD code or UMLS data; never generated content. */
export function createUmlsSymptomProvider(
  symptomsRepo: SymptomsRepo
): MedicalBasisProvider {
  return {
    id: "umls-symptoms",
    description: "Typical symptoms (UMLS database)",
    async fetch(query) {
      const icd = query.diagnosis.icd;
      const symptoms = icd
        ? symptomsRepo.SymptomsRelatedToDiagnosisIcd(icd)
        : [];
      return symptoms.map((s) => s.name).join(", ") || undefined;
    },
  };
}
