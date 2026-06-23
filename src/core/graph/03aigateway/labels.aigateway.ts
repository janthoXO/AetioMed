import type { ForeignLanguage } from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";
import { translateTermsKeyed } from "./translate.helper.js";

/**
 * Translate trace node labels (short UI strings shown while a case generates)
 * from English to the target language. Returns `{ englishLabel: translation }`.
 */
export async function translateLabelsFromEnglish(
  labels: string[],
  language: ForeignLanguage,
  context?: RequestContext
): Promise<Record<string, string>> {
  return translateTermsKeyed({
    logTag: "GenerateLabelsFromEnglish",
    taskDescription: `Translate the provided short UI status labels from English to a target language. Keep them concise and suitable as progress labels.`,
    contextLines: [`Target language: ${language}`],
    terms: labels,
    context,
  });
}
