import { ChiefComplaintToonFormat } from "../domain-models/ChiefComplaint.js";
import { GenerationFlags } from "../domain-models/GenerationFlags.js";
import { AnamnesisToonFormat } from "../domain-models/Anamnesis.js";
import {
  InconsistencyEmptyToonFormat,
  InconsistencyToonFormat,
} from "@/domain-models/Inconsistency.js";

export function toonFormatExplanationPrompt(): string {
  return "TOON format (object like YAML, arrays like CSV, header show [length] and {fields}, each entry on newline with 2-space indent)";
}

export function saveTransformToon(input: string): string {
  return (
    input
      // split all object entries onto new lines
      .replaceAll(/([^\n]+) ([\S]+:)/g, "$1\n$2")
      // replace all instances of multiple spaces between non-space characters with a newline plus the spaces
      .replaceAll(/(\S)([ ]{2,})(\S)/g, "$1\n$2$3")
      .replaceAll(/" (\S)/g, '"\n  $1')
      // push array items onto new line after header
      .replaceAll(/(\S+\[\d+\]\{[^\s]+\}:) ([^\n\r])/g, "$1\n  $2")
      // replace all instances of multiple newlines with a single newline
      .replaceAll(/[\n\r]{2,}/g, "\n")
  );
}

export function formatPromptDraftToon(
  generationFlags: GenerationFlags[]
): string {
  return `Return your response in ${toonFormatExplanationPrompt()}:
${generationFlags
  .map((flag) => {
    switch (flag) {
      case GenerationFlags.ChiefComplaint:
        return ChiefComplaintToonFormat();
      case GenerationFlags.Anamnesis:
        return AnamnesisToonFormat();
    }
  })
  .join("\n")}`;
}

export function formatPromptInconsistenciesToon(): string {
  return `If you find inconsistencies, return them in ${toonFormatExplanationPrompt()}:
${InconsistencyToonFormat()}

If everything is consistent, return:
${InconsistencyEmptyToonFormat()}`;
}
