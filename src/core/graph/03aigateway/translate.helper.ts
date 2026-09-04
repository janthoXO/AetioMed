import z from "zod";
import { retry } from "../utils/retry.js";
import { getDeterministicLLM, handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RequestContext } from "../utils/context.js";
import type { GraphRuntime } from "../runtime.js";

const KEYED_FORMAT_INSTRUCTION = `Return ONLY a JSON object mapping each provided term, exactly as given, to its translation:
{ "term 1": "translation 1", "term 2": "translation 2" }
Include every provided term as a key. Do not add, remove, merge, rename, or reorder the keys. Return ONLY the JSON object, no additional text.`;

/**
 * Translate a batch of terms via the LLM, returning a keyed record
 * `{ inputTerm: translation }`. Correspondence is by key, not by position, so a
 * dropped or reordered term is detected (the term is missing as a key) and the
 * attempt is retried with the missing terms fed back into the prompt.
 */
export async function translateTermsKeyed(
  runtime: GraphRuntime,
  opts: {
    logTag: string;
    /** One-line description of the translation task, e.g. "Translate the provided procedures from English to a target language." */
    taskDescription: string;
    /** Extra user-prompt lines, e.g. `Target language: German` or `Source language: German`. */
    contextLines: string[];
    terms: string[];
    context?: RequestContext | undefined;
  }
): Promise<Record<string, string>> {
  const { logTag, taskDescription, contextLines, terms, context } = opts;

  if (terms.length === 0) return {};

  const systemPrompt = buildPrompt(
    section("Role", taskDescription),
    section("Output format", KEYED_FORMAT_INSTRUCTION)
  );
  const baseUserPrompt = buildPrompt(
    ...contextLines,
    section("Terms to translate", terms.join("\n"))
  );

  console.debug(
    `[${logTag}] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${baseUserPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const response = await getDeterministicLLM(
        runtime.llm,
        context?.llmConfig
      )
        .withStructuredOutput(z.record(z.string(), z.string()))
        .invoke(
          [
            new SystemMessage(systemPrompt),
            new HumanMessage(
              baseUserPrompt +
                (previousError
                  ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                  : "")
            ),
          ],
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch(handleLangchainError);

      console.debug(
        `[${logTag}] [Attempt ${attempt}] Generated translations:`,
        response
      );

      const missing = terms.filter((t) => response[t] === undefined);
      if (missing.length > 0) {
        throw new Error(
          `Translation is missing keys for: ${missing.join(", ")}. Every provided term must appear as a key, spelled exactly as given.`
        );
      }

      // Keep only the requested keys, in case the model added extras.
      const result: Record<string, string> = {};
      for (const term of terms) result[term] = response[term]!;
      return result;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[${logTag}] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );
}
