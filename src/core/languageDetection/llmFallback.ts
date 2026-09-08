import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import z from "zod";
import type { GraphRuntime } from "@/core/graph/runtime.js";

/**
 * Step 3 of the ladder (issue 10 §1) — one cheap, deterministic LLM call
 * asking the model which of this deployment's configured languages the
 * given free text is written in. Only reached when the offline detector
 * (step 2) did not clear its confidence threshold, and only when a deployer
 * has opted in via `LANGUAGE_DETECT_LLM_FALLBACK` on top of
 * `LANGUAGE_AUTO_DETECT` — so nobody pays for this without asking twice.
 *
 * Best-effort: any failure (model error, or an answer outside the
 * configured set) resolves to `undefined` rather than throwing — a missing
 * guess here still degrades to step 4's configured default; it never fails
 * the whole generation request over a language-detection convenience.
 *
 * Called *before* `runWithContext` binds the request's `AsyncLocalStorage`
 * context — language resolution is what decides what to bind — so there is
 * no jobId/abort-signal to thread through yet. Acceptable for a single
 * rare, opt-in classification call; it is not registered with
 * `cancelManager`.
 */
export async function detectLanguageViaLlm(
  runtime: GraphRuntime,
  text: string,
  languages: readonly string[]
): Promise<string | undefined> {
  // `languages` is always non-empty (`LANGUAGES` guarantees "English" is
  // among them — config.ts), so this is just satisfying `z.enum`'s
  // non-empty-tuple type; the resulting array is never actually empty.
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
