import { GenerationFlags, hasFlag } from "../domain-models/GenerationFlags.js";
import { InconsistencyJsonFormat } from "@/domain-models/Inconsistency.js";
import { CaseSchema } from "@/domain-models/Case.js";
import z, { type ZodObject } from "zod";

export function formatPromptDraftJsonZod(generationFlags: number): ZodObject {
  let zodCase = CaseSchema as ZodObject;

  Object.values(GenerationFlags).forEach((flag) => {
    if (typeof flag !== "number") {
      return;
    }
    if (hasFlag(generationFlags, flag as GenerationFlags)) {
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

export function formatPromptDraftJson(generationFlags: number): string {
  return JSON.stringify(
    z.toJSONSchema(formatPromptDraftJsonZod(generationFlags))
  );
}

export function formatPromptInconsistenciesJson(): string {
  return InconsistencyJsonFormat();
}
