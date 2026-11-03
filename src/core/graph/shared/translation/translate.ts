import z from "zod";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import {
  buildPrompt,
  section,
  summarizeValidationError,
} from "@/core/graph/shared/prompt/prompt.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

const KEYED_FORMAT_INSTRUCTION = `Return ONLY a JSON object mapping each provided term, exactly as given, to its translation:
{ "term 1": "translation 1", "term 2": "translation 2" }
Include every provided term as a key. Do not add, remove, merge, rename, or reorder the keys. Return ONLY the JSON object, no additional text.`;

/**
 * One required string per key. Not `z.record`: its JSON Schema carries
 * `propertyNames`, which vLLM/xgrammar endpoints reject outright ("Grammar
 * error: Unimplemented keys"). Keys are always known at call time, so a fixed
 * object also makes every key required by construction; extras are stripped.
 */
export function keyedTranslationSchema(keys: string[]) {
  return z.object(Object.fromEntries(keys.map((k) => [k, z.string()])));
}

/**
 * Translates terms via LLM into `{ inputTerm: translation }`. Keyed, not
 * positional: a missing term fails validation and is retried with it named.
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

  // `buildPrompt`, not `buildSystemPrompt`: translator machinery; target
  // language explicit in `contextLines`, not ambient.
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
      const response = await runtime.llm.structured(
        { role: "translator", temperature: "deterministic" },
        {
          system: systemPrompt,
          user:
            baseUserPrompt +
            (previousError
              ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
              : ""),
        },
        keyedTranslationSchema(terms),
        context
      );

      console.debug(
        `[${logTag}] [Attempt ${attempt}] Generated translations:`,
        response
      );

      return response;
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
 * Translates keyed map of text values in one call into `{ key: translation }`.
 * Unlike {@link translateTermsKeyed}, key is a stable identifier (path/field
 * name), not the source text; correspondence by key membership.
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
      const response = await runtime.llm.structured(
        { role: "translator", temperature: "deterministic" },
        {
          system: systemPrompt,
          user:
            baseUserPrompt +
            (previousError
              ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
              : ""),
        },
        keyedTranslationSchema(keys),
        context
      );

      console.debug(
        `[${logTag}] [Attempt ${attempt}] Generated translations:`,
        response
      );

      return response;
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
