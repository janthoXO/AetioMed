import type { Case } from "@/domain-models/Case.js";
import type { GenerationFlags } from "@/domain-models/GenerationFlags.js";
import { generateCase as graphGenerateCase } from "@/graph/index.js";

export async function generateCase(
  diagnosis: string,
  context: string,
  generationFlags: GenerationFlags[]
): Promise<Case> {
  return graphGenerateCase(diagnosis, context, generationFlags);
}
