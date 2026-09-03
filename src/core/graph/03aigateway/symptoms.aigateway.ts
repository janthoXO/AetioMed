import {
  SymptomArrayJsonExample,
  SymptomSchema,
  type Symptom,
} from "../models/Symptom.js";
import { bus } from "@/core/graph/index.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import {
  buildPrompt,
  getDeterministicLLM,
  handleLangchainError,
} from "../utils/llm.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import z from "zod";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";

export async function generateSymptomsOneShot(
  diagnosis: Diagnosis,
  userInstructions?: string,
  symptomsToExclude: Symptom[] = [],
  context?: RequestContext
): Promise<Symptom[]> {
  const systemPrompt = buildPrompt(
    `You are a medical expert tasked with generating symptoms for a given diagnosis.`,
    symptomsToExclude.length > 0
      ? `Try to generate symptoms that are not in the list of excluded symptoms: ${symptomsToExclude.map((s) => s.name).join(", ")}`
      : undefined,
    `Return your response in JSON:\n${JSON.stringify({ symptoms: SymptomArrayJsonExample() })}`,
    `Requirements:\n- Be medically accurate and realistic\n- Use standard medical terminology\n- Return ONLY the JSON content, no additional text`
  );

  const userPrompt = buildPrompt(
    `Provided Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,
    userInstructions
      ? `Additional provided instructions: ${userInstructions}`
      : undefined
  );

  console.debug(
    `[GenerateSymptomsOneShot] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const SymptomArrayWrapperSchema = z.object({
      symptoms: SymptomSchema.array(),
    });

    const symptoms: Symptom[] = await retry(
      async () => {
        const result = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(SymptomArrayWrapperSchema)
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
          `[GenerateSymptomsOneShot] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result.symptoms;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateSymptomsOneShot] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return symptoms;
  } catch (error) {
    console.error(`[GenerateSymptomsOneShot] Error:`, error);
    throw error;
  }
}
