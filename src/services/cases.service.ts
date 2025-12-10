import {
  AnamnesisCategory,
  AnamnesisToonFormat,
} from "../domain-models/Anamnesis.js";
import type { Case } from "../domain-models/Case.js";
import { GenerationFlags, hasFlag } from "../domain-models/GenerationFlags.js";

export function generateCase(
  generationFlags: number,
  diagnosis: string,
  context?: string
): Promise<Case> {
  const caseData: Case = {};

  if (hasFlag(generationFlags, GenerationFlags.TreatmentReason)) {
    caseData.treatmentReason = "Sample treatment reason";
  }

  if (hasFlag(generationFlags, GenerationFlags.Anamnesis)) {
    caseData.anamnesis = [
      {
        category: AnamnesisCategory.Medications,
        answer: "Sample answer",
      },
    ];
  }

  console.debug(AnamnesisToonFormat());

  return Promise.resolve(caseData);
}
