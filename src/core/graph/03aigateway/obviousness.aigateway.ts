import {
  buildPrompt,
  getDeterministicLLM,
  handleLangchainError,
} from "../utils/llm.js";
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
  difficulty: Difficulty = "medium",
  userInstructions?: string,
  context?: RequestContext
): Promise<ObviousnessEvaluation> {
  const systemPrompt = buildPrompt(
    `You are an expert medical educator reviewing a clinical case blueprint for a training simulator BEFORE the full case is written out. Your job is to judge whether the blueprint makes the diagnosis too easy to guess for the requested difficulty level.`,

    `${DIFFICULTY_EXPECTATION[difficulty]}`,

    `Evaluate the blueprint holistically: the symptom selection, any distractors present, and the planned workup/procedure-result strategy described in it.`,

    `Return a JSON object with:
  "tooObvious": true if the blueprint reveals/telegraphs the diagnosis more directly than the requested difficulty allows, false otherwise.
  "reasons": an array of specific, concrete reasons (empty if not too obvious).
  "suggestion": a single actionable directive for how to regenerate the blueprint to fit the requested difficulty (omit if not too obvious).
Return ONLY the JSON object, no additional text.`
  );

  const userPrompt = buildPrompt(
    `Target Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,
    `Requested Difficulty: ${difficulty}`,
    `Blueprint to evaluate:\n${outline}`,
    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined
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
                    ? `\nPrevious generation error: ${previousError.message}`
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
