import {
  buildPrompt,
  getCreativeLLM,
  getDeterministicLLM,
  handleLangchainError,
} from "@/utils/llm.js";
import type { Diagnosis } from "@/models/Diagnosis.js";
import type { Symptom } from "@/models/Symptom.js";
import { HumanMessage, SystemMessage } from "langchain";
import { retry } from "@/utils/retry.js";
import {
  ChiefComplaintJsonExample,
  ChiefComplaintJsonSchema,
  type ChiefComplaint,
} from "@/models/ChiefComplaint.js";
import type { RequestContext } from "@/utils/context.js";
import type { Case } from "@/models/Case.js";
import type { Inconsistency } from "@/models/Inconsistency.js";

export async function generateChiefComplaintCoT(
  diagnosis: Diagnosis,
  symptoms: Symptom[],
  userInstructions?: string,
  context?: RequestContext
): Promise<string> {
  const systemPrompt = buildPrompt(
    `You are an expert medical educator specializing in designing realistic clinical mock cases for medical students. 
Your task is to generate a step-by-step logical reasoning process (Chain of Thought) detailing EXACTLY HOW to construct the Chief Complaint`,

    `The following symptoms are typical for the diagnosis. You may use a subset of them:
${symptoms.map((s, idx) => `${idx + 1}. ${s.name}: ${s.description ?? ""}`).join("\n")}`,

    `Instructions:
1. The chief complaint will be written from the perspective of a medical professional writing in a clinical chart.
2. DO NOT generate the actual chief complaint yet. Only generate the thinking process which should be specific to the given diagnosis and a subset of symptoms.
3. Outline a sequential thought process.
4. Output ONLY the numbered reasoning steps, without any conversational filler.`
  );

  const userPrompt = buildPrompt(
    `Target Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,

    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined
  );

  console.debug(
    `[GenerateChiefComplaintCoT] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const stepsString: string = await retry(
      async (attempt: number) => {
        const text = await getDeterministicLLM({
          ...context?.llmConfig,
          outputFormat: "text",
        })
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });
        console.debug(
          `[GenerateChiefComplaintCoT] [Attempt ${attempt}] LLM raw Response:\n`,
          text.text
        );

        return text.text;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateChiefComplaintCoT] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        context?.traceUtils?.emitTrace(msg, { category: "error" });
      }
    );

    return stepsString;
  } catch (error) {
    console.error(`[GenerateChiefComplaintCoT] Error:`, error);
    throw error;
  }
}

export async function generateChiefComplaint(
  diagnosis: Diagnosis, // provided by the user
  config:
    | {
        cot: string;
        symptoms: Symptom[];
      }
    | {
        outline: string;
      }
    | {
        case: Case;
        inconsistencies: Inconsistency[];
      },
  userInstructions?: string, // provided by the user | undefined
  context?: RequestContext
): Promise<ChiefComplaint> {
  const systemPrompt = buildPrompt(
    `You are an expert attending physician documenting a patient's presentation for a medical training simulator.
Your current task is to generate the Chief Complaint ${"outline" in config ? "based on the provided Case Outline" : ""}.`,

    "cot" in config
      ? `The following symptoms are typical for the diagnosis. You may use a subset of them:
      ${config.symptoms.map((s, idx) => `${idx + 1}. ${s.name}: ${s.description ?? ""}`).join("\n")}

Think step by step:
    ${config.cot}`
      : undefined,

    "outline" in config
      ? `Generate the chief complaint from scratch based on the approved outline.`
      : undefined,

    "inconsistencies" in config
      ? `The previous JSON generation contained clinical or logical inconsistencies. Regenerate the JSON, fixing the following issues while maintaining the professional medical tone:

Original Chief Complaint:
${JSON.stringify({ chiefComplaint: config.case.chiefComplaint })}

Inconsistencies to Fix:
${config.inconsistencies.map((i, idx) => `${idx + 1}. [Severity ${i.severity}] ${i.description}\n   Suggested Fix: ${i.suggestion}`).join("\n")}`
      : undefined,

    `Return ONLY a valid JSON object matching the schema below.
Schema:
${JSON.stringify(ChiefComplaintJsonExample())}`,

    `Requirements:
- The text inside the JSON must be written from the perspective of a medical professional writing in a clinical chart.
- Use concise, objective clinical language and standard medical terminology (e.g., "acute onset dyspnea" instead of "shortness of breath").
- Ensure it directly aligns with the demographic data and symptoms specified in the outline.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
  );

  const userPrompt = buildPrompt(
    `Target Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,

    "outline" in config ? `Case Outline: ${config.outline}` : undefined,

    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined
  );

  console.debug(
    `[GenerateChiefComplaintFromOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const chiefComplaint: ChiefComplaint = await retry(
      async (attempt: number) => {
        const result = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(ChiefComplaintJsonSchema)
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });
        console.debug(
          `[GenerateChiefComplaintFromOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return result.chiefComplaint;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateChiefComplaintFromOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        context?.traceUtils?.emitTrace(msg, { category: "error" });
      }
    );

    return chiefComplaint;
  } catch (error) {
    console.error(`[GenerateChiefComplaintFromOutline] Error:`, error);
    throw error;
  }
}
