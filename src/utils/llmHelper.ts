import { ChiefComplaintDescriptionPrompt } from "../domain-models/ChiefComplaint.js";
import { type GenerationFlags } from "../domain-models/GenerationFlags.js";
import { AnamnesisDescriptionPrompt } from "../domain-models/Anamnesis.js";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ModelUnreachableError } from "@/errors/AppError.js";

export function descriptionPromptDraft(
  generationFlags: GenerationFlags[]
): string {
  return generationFlags
    .map((flag) => {
      switch (flag) {
        case "chiefComplaint":
          return ChiefComplaintDescriptionPrompt();
        case "anamnesis":
          return AnamnesisDescriptionPrompt();
      }
    })
    .join("\n");
}

/**
 * Decodes a string into an object based on the configured LLM format.
 * @param input
 * @returns
 */
export async function decodeObject(input: string): Promise<object> {
  const parser = new JsonOutputParser();
  return parser.parse(input);
}

export function handleLangchainError(error: Error): never {
  if (error instanceof Error) {
    if (
      error.message.includes("fetch failed") ||
      error.message.includes("ECONNREFUSED")
    ) {
      throw new ModelUnreachableError(
        "Ollama service is unreachable. Is it running?",
        error.message
      );
    }
  }

  throw error;
}
