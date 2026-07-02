import {
  buildPrompt,
  getCreativeLLM,
  handleLangchainError,
} from "../utils/llm.js";
import { bus } from "@/core/graph/index.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { Symptom } from "../models/Symptom.js";
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
  generationFlags: Omit<GenerationFlag, "procedures">[],
  symptoms: Symptom[],
  difficulty: Difficulty = "medium",
  userInstructions?: string,
  feedback?: string[],
  context?: RequestContext
): Promise<string> {
  const systemPrompt = buildPrompt(
    `You are an expert medical educator tasked with creating a concrete, outline for a clinical practice case based on a specific diagnosis.`,
    `You must outline the specific content and direction for the following required fields:
${generationFlags.join(", ")}`,

    `This blueprint will act as the SINGLE SOURCE OF TRUTH for downstream AI agents generating the final JSON fields, INCLUDING the eventual procedure/workup results. It must contain specific, hard data outlining the content of each field.`,

    `Typical symptoms associated with this diagnosis are:
${symptoms.map((s) => s.name).join(", ")}
(You should select a clinically coherent subset of these symptoms to feature in the patient's presentation).`,

    `Difficulty Strategy (${difficulty}) — this controls how unclear the diagnosis must remain to a student working through the case, both in the presentation AND in any workup/procedure results:
${DIFFICULTY_STRATEGY[difficulty]}`,

    `Instructions:
1. Generate a structured markdown outline that briefly describes the exact clinical content that will go into each required field.
2. Make sure that all fields are clinically coherent to each other
3. Do not write the full narrative text for the fields yet; provide the essential details needed to formulate them.
4. Include a dedicated "Workup / Procedure Results Strategy" section describing how procedure and lab results should be shaped per the difficulty strategy above, so a downstream agent generating those results can follow it.
5. The diagnosis must never be explicitly named anywhere in the outline's field content — the student must deduce it.
6. Return ONLY the markdown outline. Do not include introductory text, acknowledgments, or conversational filler.`,

    feedback && feedback.length > 0
      ? `The previous outline was rejected as too obvious for the requested difficulty. Address the following feedback when regenerating:
${feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
      : undefined
  );

  const userPrompt = buildPrompt(
    `Target Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,
    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined
  );

  console.debug(
    `[GenerateCaseOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const outline: string = await retry(
      async (attempt: number) => {
        const result = await getCreativeLLM({
          ...context?.llmConfig,
          outputFormat: "text",
        })
          .invoke(
            [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
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
