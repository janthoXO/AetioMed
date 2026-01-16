import type { Case } from "@/domain-models/Case.js";
import type { GenerationFlags } from "@/domain-models/GenerationFlags.js";
import type { Language } from "@/domain-models/Language.js";
import { generateCase as graphGenerateCase } from "@/graph/case-generation/index.js";
import { translateCase } from "@/graph/translation/index.js";

export async function generateCase(
  icdCode: string | undefined,
  diseaseName: string,
  generationFlags: GenerationFlags[],
  context?: string,
  language?: Language
): Promise<Case> {
  let generatedCase = await graphGenerateCase(
    icdCode,
    diseaseName,
    generationFlags,
    context
  );

  if (language) {
    generatedCase = await translateCase(generatedCase, language);
  }

  return generatedCase;
}
