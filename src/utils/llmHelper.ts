import {
  ChiefComplaintDescriptionPrompt,
  ChiefComplaintToonFormat,
} from "../domain-models/ChiefComplaint.js";
import { type GenerationFlags } from "../domain-models/GenerationFlags.js";
import {
  AnamnesisDescriptionPrompt,
  AnamnesisToonFormat,
} from "../domain-models/Anamnesis.js";
import { config } from "./config.js";
import {
  saveTransformToon,
  toonFormatExplanationPrompt,
} from "./toonHelper.js";
import { decode, encode } from "@toon-format/toon";
import { CaseJsonExampleString } from "@/domain-models/Case.js";
import {
  InconsistencyEmptyToonFormat,
  InconsistencyJsonExample,
  InconsistencyArrayToonFormat,
} from "@/domain-models/Inconsistency.js";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ModelUnreachableError } from "@/errors/AppError.js";
import type { Language } from "@/domain-models/Language.js";

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
 * Specifies the format description + the structure of the expected output
 * @param generationFlags
 * @returns
 */
export function formatPromptDraft(
  generationFlags: GenerationFlags[],
  language: Language = "English"
): string {
  switch (config.LLM_FORMAT) {
    case "TOON":
      return `Return your response in ${toonFormatExplanationPrompt()}:
${generationFlags
  .map((flag) => {
    switch (flag) {
      case "chiefComplaint":
        return ChiefComplaintToonFormat();
      case "anamnesis":
        return AnamnesisToonFormat(language);
    }
  })
  .join("\n")}`;
    case "JSON":
      return `Return your response in JSON:\n${CaseJsonExampleString(generationFlags, language)}`;
  }
}

/**
 *
 * @returns a format string representing the object {draftIndex: number}
 */
export function formatPromptDraftVote(): string {
  switch (config.LLM_FORMAT) {
    case "TOON":
      return `Return your response in ${toonFormatExplanationPrompt()}:
draftIndex: number`;
    case "JSON":
      return `Return your response in JSON:\n{draftIndex: number}`;
  }
}

/**
 *
 * @returns a format string representing the object {inconsistenies: Inconsistency[]}
 */
export function formatPromptInconsistencies(): string {
  switch (config.LLM_FORMAT) {
    case "TOON":
      return `If you find inconsistencies, return them in ${toonFormatExplanationPrompt()}:
${InconsistencyArrayToonFormat()}

If everything is consistent, return:
${InconsistencyEmptyToonFormat()}`;
    case "JSON":
      return `Return your response in JSON:\n${JSON.stringify({ inconsistencies: [InconsistencyJsonExample()] })}`;
  }
}

/**
 * Encodes an object into a string based on the configured LLM format.
 * @param input
 * @returns
 */
export function encodeObject(input: object): string {
  switch (config.LLM_FORMAT) {
    case "TOON":
      return encode(input);
    case "JSON":
      return JSON.stringify(input, null, 2);
  }
}

/**
 * Decodes a string into an object based on the configured LLM format.
 * @param input
 * @returns
 */
export async function decodeObject(input: string): Promise<object> {
  switch (config.LLM_FORMAT) {
    case "TOON":
      return decode(saveTransformToon(input)) as object;
    case "JSON": {
      const parser = new JsonOutputParser();
      return parser.parse(input);
    }
  }
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
