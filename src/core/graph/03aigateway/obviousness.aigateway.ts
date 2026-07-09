import { getDeterministicLLM, handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import { bus } from "@/core/graph/index.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { Difficulty } from "../models/Difficulty.js";
import {
  ObviousnessEvaluationSchema,
  type ObviousnessEvaluation,
} from "../models/Obviousness.js";
import { retry } from "../utils/retry.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RequestContext } from "../utils/context.js";

const DIFFICULTY_EXPECTATION: Record<Difficulty, string> = {
  easy: `At "easy" difficulty, the blueprint is EXPECTED to point fairly directly toward the diagnosis via a classic subset of hallmark symptoms. Only flag it as too obvious if the diagnosis name itself, or an unambiguous synonym/abbreviation of it, is leaked in the outline text.`,
  medium: `At "medium" difficulty, the blueprint should require some deductive reasoning: a subset of hallmark symptoms plus at least one distractor symptom or a borderline procedure-result change. Flag it as too obvious if the presentation is a textbook, unambiguous match for the diagnosis with no distractors or ambiguity at all, or if the diagnosis name is leaked.`,
  hard: `At "hard" difficulty, the blueprint must present an atypical picture: at least one omitted hallmark symptom, multiple distractor/differential symptoms, and ambiguous procedure results. Flag it as too obvious if the presentation is a clean or typical match for the diagnosis, if there are no meaningful distractors, or if the diagnosis name is leaked.`,
};

/**
 * Judge whether a case blueprint reveals the diagnosis more directly than the
 * requested difficulty permits. Runs immediately after outline generation, before
 * any field content is written, so an over-obvious case can be caught early.
 */
export async function evaluateOutlineObviousness(
  diagnosis: Diagnosis,
  outline: string,
  difficulty: Difficulty,
  userInstructions?: string,
  context?: RequestContext
): Promise<ObviousnessEvaluation> {
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert medical educator reviewing a clinical case blueprint for a training simulator BEFORE the full case is written out. Your job is to judge whether the blueprint makes the diagnosis too easy to guess for the requested difficulty level.`
    ),

    section(
      "Rules",
      `Evaluate the blueprint holistically: the symptom selection, any distractors present, and the planned workup/procedure-result strategy described in it.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(ObviousnessEvaluationSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section(
      `Requested difficulty (${difficulty})`,
      DIFFICULTY_EXPECTATION[difficulty]
    ),

    section("Blueprint to evaluate", outline),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[EvaluateOutlineObviousness] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const evaluation: ObviousnessEvaluation = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(ObviousnessEvaluationSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(
                userPrompt +
                  (previousError
                    ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                    : "")
              ),
            ],
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[EvaluateOutlineObviousness] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return { ...result, reasons: result.reasons ?? [] };
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[EvaluateOutlineObviousness] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return evaluation;
  } catch (error) {
    console.error("[EvaluateOutlineObviousness] Error:", error);
    throw error;
  }
}
