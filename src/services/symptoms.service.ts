import type { Symptom } from "@/domain-models/Symptom.js";
import symptomData from "../data/disease_symptoms.json" with { type: "json" };
import type { ICDCode } from "@/domain-models/ICD.js";

const symptomMap = symptomData as Record<string, { symptoms: Symptom[] }>;

export function SymptomsRelatedToDiseaseIcd(icdCode: ICDCode): Symptom[] {
  return symptomMap[icdCode]?.symptoms || [];
}
