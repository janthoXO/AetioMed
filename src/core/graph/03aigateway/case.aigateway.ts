import { getCreativeLLM, handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import { bus } from "@/core/graph/index.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { Symptom } from "../models/Symptom.js";
import { getEffectiveCategoryList } from "../03repo/anamnesis.repo.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import type { GenerationFlag } from "../models/GenerationFlags.js";
import type { Difficulty } from "../models/Difficulty.js";

const DIFFICULTY_STRATEGY: Record<Difficulty, string> = {
  easy: `- Feature a clear, classic subset of this diagnosis's hallmark symptoms only. Do not include distractor symptoms from other conditions.
- Procedure/workup results should be definitive and textbook — clearly consistent with the diagnosis, with no ambiguity.
- The clinical picture should point toward the diagnosis fairly directly, while still never naming it.`,
  medium: `- Feature a clinically coherent subset of this diagnosis's hallmark symptoms, and additionally introduce 1–2 distractor symptoms drawn from a plausible differential diagnosis.
- Introduce minor or borderline changes in procedure/workup results (e.g. a value just outside normal range, a partially non-specific finding) so the picture is not immediately conclusive.
- The overall presentation should require some deductive reasoning; it should not be solvable from the chief complaint alone.`,
  hard: `- Present an atypical picture: omit one or more classic hallmark symptoms of this diagnosis, and include several distractor/differential symptoms from other plausible conditions.
- Make procedure/workup results ambiguous or requiring interpretation — avoid clean textbook values; results should be consistent with the diagnosis only on careful analysis.
- The case should require synthesizing multiple pieces of evidence and actively ruling out plausible alternatives before reaching the diagnosis.`,
};

export async function generateCaseOutline(
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  symptoms: Symptom[],
  difficulty: Difficulty,
  userInstructions?: string,
  feedback?: string[],
  previousOutline?: string,
  context?: RequestContext
): Promise<string> {
  const effectiveCategories = generationFlags.includes("anamnesis")
    ? getEffectiveCategoryList(context?.language)
    : undefined;

  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert medical educator tasked with creating a concrete outline for a clinical practice case based on a specific diagnosis.
This blueprint will act as the SINGLE SOURCE OF TRUTH for downstream AI agents generating the final JSON fields, INCLUDING the eventual procedure/workup results. It is the COMPLETE FACTUAL RECORD of the case: downstream agents only rewrite its facts in the right voice and format — they never add facts of their own.`
    ),

    section(
      "Instructions",
      `1. Generate a structured markdown outline with one section per required field, containing hard, concrete data:
   - Patient: exact age, gender, height (in cm), weight (in kg), and any relevant demographic details.
   - Symptoms/presentation: the selected symptom subset with concrete onset, duration, severity, and timeline.
   - Chief complaint: the specific presenting problem in one or two factual sentences.
   - Anamnesis: for each intake form category, the concrete facts to state (history items, medications with names and doses, lifestyle details, family history).
2. Downstream generators must be able to write their field using ONLY facts from this outline. Any fact not specified here does not exist. Do not leave placeholders or vague descriptions.
3. Make sure that all fields are clinically coherent to each other.
4. Include a dedicated "Workup / Procedure Results Strategy" section describing how procedure and lab results should be shaped per the difficulty strategy, so a downstream agent generating those results can follow it.
5. The diagnosis must never be explicitly named anywhere in the outline's field content — the student must deduce it.
6. Return ONLY the markdown outline. Do not include introductory text, acknowledgments, or conversational filler.`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section(
      "Required fields to outline",
      `You must outline the specific content and direction for the following required fields:
${generationFlags.join(", ")}`
    ),

    section(
      "Typical symptoms",
      `Typical symptoms associated with this diagnosis are:
${symptoms.map((s) => s.name).join(", ")}
(You should select a clinically coherent subset of these symptoms to feature in the patient's presentation).`
    ),

    section(
      `Difficulty strategy (${difficulty})`,
      `This controls how unclear the diagnosis must remain to a student working through the case, both in the presentation AND in any workup/procedure results:
${DIFFICULTY_STRATEGY[difficulty]}`
    ),

    effectiveCategories
      ? section(
          "Anamnesis intake form categories",
          `The anamnesis section of the outline must specify concrete facts for each of these intake form categories, using their exact names:
${effectiveCategories.join(", ")}`
        )
      : undefined,

    section("Additional instructions", userInstructions),

    previousOutline
      ? section("Previous outline (rejected)", previousOutline)
      : undefined,

    feedback && feedback.length > 0
      ? section(
          "Feedback on the previous outline",
          `The previous outline was rejected for the following reasons. Revise it — keep what was good, and change only what is needed to address the feedback:
${feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
        )
      : undefined
  );

  console.debug(
    `[GenerateCaseOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const outline: string = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getCreativeLLM({
          ...context?.llmConfig,
          outputFormat: "text",
        })
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
          `[GenerateCaseOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          result.text
        );

        return result.text;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateCaseOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return outline;
  } catch (error) {
    console.error(`[GenerateCaseOutline] Error:`, error);
    throw error;
  }
}
