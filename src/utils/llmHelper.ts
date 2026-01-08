import { ChiefComplaintDescriptionPrompt } from "../domain-models/ChiefComplaint.js";
import { type GenerationFlags } from "../domain-models/GenerationFlags.js";
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

export function formatPromptDraft(generationFlags: GenerationFlags[]): string {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeObject(input: string): Record<string, any> {
  switch (config.LLM_FORMAT) {
    case "TOON":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return decode(saveTransformToon(input)) as Record<string, any>;
    case "JSON":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return JSON.parse(input) as Record<string, any>;
  }
}
