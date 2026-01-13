import { z, ZodObject } from "zod/v4";
import { AnamnesisJsonExample, AnamnesisSchema } from "./Anamnesis.js";
import { ChiefComplaintSchema } from "./ChiefComplaint.js";
import { AllGenerationFlags, type GenerationFlags } from "./GenerationFlags.js";

/**
 * Zod schema for a complete medical case
 */
export const CaseSchema = z.object({
  chiefComplaint: ChiefComplaintSchema.optional(),
  anamnesis: AnamnesisSchema.optional(),
});

export type Case = z.infer<typeof CaseSchema>;

export function CaseJsonFormatZod(
  generationFlags?: GenerationFlags[]
): ZodObject {
  let zodCase = CaseSchema as ZodObject;

  AllGenerationFlags.forEach((flag) => {
    if (generationFlags?.some((f) => f === flag)) {
      return;
    }

    // flag which is not in the generationFlags - remove from zodCase
    switch (flag) {
      case "chiefComplaint":
        zodCase = zodCase.omit({ chiefComplaint: true });
        break;
      case "anamnesis":
        zodCase = zodCase.omit({ anamnesis: true });
        break;
      default:
        break;
    }
  });

  return zodCase;
}

export function CaseJsonExample(generationFlags?: GenerationFlags[]): Case {
  const exampleCase: Case = {
    chiefComplaint: "The patients chief complaint",
    anamnesis: AnamnesisJsonExample(),
  };

  AllGenerationFlags.forEach((flag) => {
    if (generationFlags?.some((f) => f === flag)) {
      return;
    }

    // flag which is not in the generationFlags - remove from exampleCase
    switch (flag) {
      case "chiefComplaint":
        delete exampleCase.chiefComplaint;
        break;
      case "anamnesis":
        delete exampleCase.anamnesis;
        break;
      default:
        break;
    }
  });

  return exampleCase;
}

export function CaseJsonExampleString(
  generationFlags?: GenerationFlags[]
): string {
  return JSON.stringify(CaseJsonExample(generationFlags));
}
