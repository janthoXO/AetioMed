import type { Case } from "@/domain-models/Case.js";
import type { GenerationFlags } from "@/domain-models/GenerationFlags.js";
import { generateCase as graphGenerateCase } from "@/graph/case-generation/index.js";

export async function generateCase(
  icdCode: string,
  diseaseName: string,
  context: string,
  generationFlags: GenerationFlags[]
): Promise<Case> {
  return graphGenerateCase(icdCode, diseaseName, context, generationFlags);
}
