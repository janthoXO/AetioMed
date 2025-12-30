import type { Case } from "@/domain-models/Case.js";
import { generateCase as graphGenerateCase } from "@/graph/index.js";

export async function generateCase(
  generationFlags: number,
  diagnosis: string,
  context?: string
): Promise<Case> {
  return graphGenerateCase(diagnosis, generationFlags, context || "");
}
