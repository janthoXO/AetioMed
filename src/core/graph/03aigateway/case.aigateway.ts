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

export async function generateCaseOutline(
  diagnosis: Diagnosis,
  generationFlags: Omit<GenerationFlag, "procedures">[],
  symptoms: Symptom[],
  userInstructions?: string,
  context?: RequestContext
): Promise<string> {
  const systemPrompt = buildPrompt(
    `You are an expert medical educator tasked with creating a concrete, outline for a clinical practice case based on a specific diagnosis.`,
    `You must outline the specific content and direction for the following required fields:
${generationFlags.join(", ")}`,

    `This blueprint will act as the SINGLE SOURCE OF TRUTH for downstream AI agents generating the final JSON fields. It must contain specific, hard data outlining the content of each field.`,

    `Typical symptoms associated with this diagnosis are:
${symptoms.map((s) => s.name).join(", ")}
(You should select a clinically coherent subset of these symptoms to feature in the patient's presentation).`,

    `Instructions:
1. Generate a structured markdown outline that briefly describes the exact clinical content that will go into each required field.
2. Make sure that all fields are clinically coherent to each other
3. Do not write the full narrative text for the fields yet; provide the essential details needed to formulate them.
4. Return ONLY the markdown outline. Do not include introductory text, acknowledgments, or conversational filler.`
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
