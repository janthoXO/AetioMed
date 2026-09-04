import z from "zod";
import { retry } from "../utils/retry.js";
import { handleLangchainError } from "../utils/llm.js";
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

  // Deliberately `buildPrompt`, not `buildSystemPrompt` (issue 09 §3): this
  // is shared translator-role machinery (`translate_*_from_english`) whose
  // target language is already explicit in `contextLines` below, passed by
  // the caller rather than read off the ambient request language — the
  // generic directive would be redundant here, not wrong, but this stays
  // out of the "every generation gateway" conversion on purpose.
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
      const response = await runtime.llm
        .for(
          { role: "translator", temperature: "deterministic" },
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

const KEYED_RECORD_FORMAT_INSTRUCTION = `Return ONLY a JSON object with exactly the same keys as the input, each mapped to the translation of its value:
{ "key1": "translation of value1", "key2": "translation of value2" }
Do not add, remove, merge, rename, or reorder the keys. Return ONLY the JSON object, no additional text.`;

/**
 * Translate a keyed map of arbitrary text values via the LLM in one call,
 * returning a same-keyed record `{ key: translation }`. Unlike
 * {@link translateTermsKeyed}, the key need not be (and, for issue 12's
 * rest pass and translate-in userInstructions, must not be) the text being
 * translated — the key is a stable identifier (a path or a field name), so
 * correspondence is asserted by key membership, not by echoing the source
 * text back as a key.
 */
export async function translateRecordKeyed(
  runtime: GraphRuntime,
  opts: {
    logTag: string;
    /** One-line description of the translation task. */
    taskDescription: string;
    /** Extra user-prompt lines, e.g. `Target language: German`. */
    contextLines: string[];
    values: Record<string, string>;
    context?: RequestContext | undefined;
  }
): Promise<Record<string, string>> {
  const { logTag, taskDescription, contextLines, values, context } = opts;

  const keys = Object.keys(values);
  if (keys.length === 0) return {};

  const systemPrompt = buildPrompt(
    section("Role", taskDescription),
    section("Output format", KEYED_RECORD_FORMAT_INSTRUCTION)
  );
  const baseUserPrompt = buildPrompt(
    ...contextLines,
    section("Values to translate", JSON.stringify(values))
  );

  console.debug(
    `[${logTag}] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${baseUserPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const response = await runtime.llm
        .for(
          { role: "translator", temperature: "deterministic" },
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

      const missing = keys.filter((k) => response[k] === undefined);
      if (missing.length > 0) {
        throw new Error(
          `Translation is missing keys for: ${missing.join(", ")}. Every provided key must appear in the response, spelled exactly as given.`
        );
      }

      const result: Record<string, string> = {};
      for (const key of keys) result[key] = response[key]!;
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
