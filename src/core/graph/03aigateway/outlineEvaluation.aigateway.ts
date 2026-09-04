import { handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { Difficulty } from "../models/Difficulty.js";
import {
  OutlineEvaluationSchema,
  type OutlineEvaluation,
} from "../models/OutlineEvaluation.js";
import { retry } from "../utils/retry.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RequestContext } from "../utils/context.js";
import type { GraphRuntime } from "../runtime.js";

const DIFFICULTY_EXPECTATION: Record<Difficulty, string> = {
  easy: `At "easy" difficulty, the blueprint is EXPECTED to point fairly directly toward the diagnosis via a classic subset of hallmark symptoms. Only flag it as too obvious if the diagnosis name itself, or an unambiguous synonym/abbreviation of it, is leaked in the outline text.`,
  medium: `At "medium" difficulty, the blueprint should require some deductive reasoning: a subset of hallmark symptoms plus at least one distractor symptom or a borderline procedure-result change. Flag it as too obvious if the presentation is a textbook, unambiguous match for the diagnosis with no distractors or ambiguity at all, or if the diagnosis name is leaked.`,
  hard: `At "hard" difficulty, the blueprint must present an atypical picture: at least one omitted hallmark symptom, multiple distractor/differential symptoms, and ambiguous procedure results. Flag it as too obvious if the presentation is a clean or typical match for the diagnosis, if there are no meaningful distractors, or if the diagnosis name is leaked.`,
};

/**
 * Judge a case blueprint in a single call on both quality dimensions:
 * 1. Obviousness — does it reveal the diagnosis more directly than the
 *    requested difficulty permits?
 * 2. Clinical consistency — diagnosis secrecy, coherence between the planned
 *    fields, and realism of the planned facts.
 * Runs immediately after outline generation, before any field content is
 * written, so a flawed blueprint can be revised early.
 */
export async function evaluateOutline(
  runtime: GraphRuntime,
  diagnosis: Diagnosis,
  outline: string,
  difficulty: Difficulty,
  userInstructions?: string,
  context?: RequestContext
): Promise<OutlineEvaluation> {
  // Internal artifact (issue 09 §3): the plan judge, English always.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "internal",
    section(
      "Role",
      `You are an expert medical educator reviewing a clinical case blueprint for a training simulator BEFORE the full case is written out. The blueprint is the single source of truth for all downstream field generation, so it must be sound. Judge it on TWO dimensions and accept it only if BOTH pass.`
    ),

    section(
      "Dimension 1: Obviousness",
      `Judge whether the blueprint makes the diagnosis too easy to guess for the requested difficulty level. Evaluate it holistically: the symptom selection, any distractors present, and the planned workup/procedure-result strategy described in it.`
    ),

    section(
      "Dimension 2: Clinical consistency",
      `1. Diagnosis Secrecy (Pedagogical): The target diagnosis MUST NOT be explicitly named anywhere in the blueprint's field content (the student is supposed to deduce it).
2. Clinical Coherence: Do the planned fields logically align? (e.g., Does the workup strategy make sense for the chief complaint? Does the planned anamnesis contradict the patient's age/gender?)
3. Realism: Are there impossible biometric values (e.g., a 2-year-old weighing 70kg), contradictory timelines, or medical hallucinations?

IMPORTANT: Distractor symptoms, omitted hallmark symptoms, and ambiguous or borderline findings planned per the difficulty strategy are INTENTIONAL pedagogical design — do NOT flag them as inconsistencies.`
    ),

    section(
      "Requirements",
      `- Be thorough but fair. Only flag genuine problems, not stylistic choices.
- If the blueprint is rejected, list concrete reasons and give ONE actionable suggestion describing exactly how to revise it.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(OutlineEvaluationSchema)}`
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
    `[EvaluateOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const evaluation: OutlineEvaluation = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await runtime.llm
          .for(
            { role: "judge", temperature: "deterministic" },
            context?.llmConfig
          )
          .withStructuredOutput(OutlineEvaluationSchema)
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
          `[EvaluateOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return { ...result, reasons: result.reasons ?? [] };
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[EvaluateOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return evaluation;
  } catch (error) {
    console.error("[EvaluateOutline] Error:", error);
    throw error;
  }
}
