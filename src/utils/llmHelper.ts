import { ChiefComplaintDescriptionPrompt } from "../domain-models/ChiefComplaint.js";
import { GenerationFlags, hasFlag } from "../domain-models/GenerationFlags.js";
import { AnamnesisDescriptionPrompt } from "../domain-models/Anamnesis.js";
import { config } from "./config.js";
import {
  formatPromptDraftToon,
  formatPromptInconsistenciesToon,
  saveTransformToon,
} from "./toonHelper.js";
import {
  formatPromptDraftJson,
  formatPromptInconsistenciesJson,
} from "./jsonHelper.js";
import { decode, encode } from "@toon-format/toon";

export function descriptionPromptDraft(generationFlags: number): string {
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
          return ChiefComplaintDescriptionPrompt();
        case GenerationFlags.Anamnesis:
          return AnamnesisDescriptionPrompt();
        default:
          return "";
      }
    })
    .filter((s) => s !== "")
    .join("\n");
}

export function formatPromptDraft(generationFlags: number): string {
  switch (config.LLM_FORMAT) {
    case "TOON":
      return formatPromptDraftToon(generationFlags);
    case "JSON":
      return formatPromptDraftJson(generationFlags);
  }
}

/**
 *
 * @returns a format string representing the object {inconsistenies: Inconsistency[]}
 */
export function formatPromptInconsistencies(): string {
  switch (config.LLM_FORMAT) {
    case "TOON":
      return formatPromptInconsistenciesToon();
    case "JSON":
      return formatPromptInconsistenciesJson();
  }
}

export function encodeLLMRequest(input: object): string {
  switch (config.LLM_FORMAT) {
    case "TOON":
      return encode(input);
    case "JSON":
      return JSON.stringify(input, null, 2);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeLLMResponse(input: string): Record<string, any> {
  switch (config.LLM_FORMAT) {
    case "TOON":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return decode(saveTransformToon(input)) as Record<string, any>;
    case "JSON":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return JSON.parse(input) as Record<string, any>;
  }
}
