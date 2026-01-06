import {
  AllGenerationFlags,
  GenerationFlags,
} from "../domain-models/GenerationFlags.js";
import { InconsistencyJsonFormat } from "@/domain-models/Inconsistency.js";
import { CaseSchema } from "@/domain-models/Case.js";
import z, { type ZodObject } from "zod";

export function formatPromptDraftJsonZod(
  generationFlags: GenerationFlags[]
): ZodObject {
  let zodCase = CaseSchema as ZodObject;

  AllGenerationFlags.forEach((flag) => {
    if (generationFlags.some((f) => f === flag)) {
      return;
    }

    // flag which is not in the generationFlags - remove from zodCase
    switch (flag) {
      case GenerationFlags.ChiefComplaint:
        zodCase = zodCase.omit({ chiefComplaint: true });
        break;
      case GenerationFlags.Anamnesis:
        zodCase = zodCase.omit({ anamnesis: true });
        break;
      default:
        break;
    }
  });

  return zodCase;
}

export function formatPromptDraftJson(
  generationFlags: GenerationFlags[]
): string {
  return JSON.stringify(
    z.toJSONSchema(formatPromptDraftJsonZod(generationFlags))
  );
}

export function formatPromptInconsistenciesJson(): string {
  return InconsistencyJsonFormat();
}
