import { ChiefComplaintToonFormat } from "../domain-models/ChiefComplaint.js";
import { GenerationFlags, hasFlag } from "../domain-models/GenerationFlags.js";
import { AnamnesisToonFormat } from "../domain-models/Anamnesis.js";

export function formatPromptDraftJson(generationFlags: number): string {
  return Object.values(GenerationFlags)
    .map((flag) => {
      if (typeof flag !== "number") {
        return "";
      }
      if (!hasFlag(generationFlags, flag as GenerationFlags)) {
        return "";
      }

      switch (flag) {
        case GenerationFlags.ChiefComplaint:
          return ChiefComplaintToonFormat();
        case GenerationFlags.Anamnesis:
          return AnamnesisToonFormat();
        default:
          return "";
      }
    })
    .filter((s) => s !== "")
    .join("\n");
}

export function formatPromptInconsistenciesJson(): string {
  throw new Error("Not implemented");
}
