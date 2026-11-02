import type { UmlsSymptomFloor } from "@/core/graph/02-plan/01-basis/ports.js";
import type { MedicalBasisProvider } from "@/core/graph/02-plan/01-basis/ports.js";

/** UMLS symptoms for the diagnosis's ICD code. Nothing without an ICD code or UMLS data; never generated content. */
export function createUmlsSymptomProvider(
  umlsFloor: UmlsSymptomFloor
): MedicalBasisProvider {
  return {
    id: "umls-symptoms",
    description: "Typical symptoms (UMLS database)",
    async fetch(query) {
      const icd = query.diagnosis.icd;
      const symptoms = icd ? umlsFloor.SymptomsRelatedToDiagnosisIcd(icd) : [];
      return symptoms.map((s) => s.name).join(", ") || undefined;
    },
  };
}
