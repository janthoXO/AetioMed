import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import z from "zod";
import type { GraphRuntime } from "@/core/graph/runtime.js";

/**
 * Step 3 of ladder: one deterministic LLM call picking which configured
 * language `text` is in. Only when offline detector is under threshold and
 * `LANGUAGE_DETECT_LLM_FALLBACK` is on.
 *
 * Best-effort: any failure or out-of-set answer resolves `undefined`, falls to step 4.
 *
 * Runs before `runWithContext`: no jobId/abort signal.
 */
export async function detectLanguageViaLlm(
  runtime: GraphRuntime,
  text: string,
  languages: readonly string[]
): Promise<string | undefined> {
  // `languages` always non-empty (English mandatory); cast only satisfies `z.enum` tuple type.
  const choices = [...languages, "none"] as unknown as [string, ...string[]];

  try {
    const response = await runtime.llm
      .for({ role: "translator", temperature: "deterministic" })
      .withStructuredOutput(z.object({ language: z.enum(choices) }))
      .invoke([
        new SystemMessage(
          `Identify which of these languages the user's text is written in: ` +
            `${languages.join(", ")}. Respond with "none" if you cannot tell.`
        ),
        new HumanMessage(text),
      ]);

    return response.language === "none" ? undefined : response.language;
  } catch (error) {
    console.warn(
      "[languageDetection] LLM fallback failed; falling back to the configured default language.",
      error
    );
    return undefined;
  }
}
