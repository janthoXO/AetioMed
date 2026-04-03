import type { ForeignLanguage } from "@/core/models/Language.js";
import { publishEvent } from "@/core/eventBus/index.js";
import { retry } from "@/core/utils/retry.js";
import z from "zod";
import {
  buildPrompt,
  getCreativeLLM,
  getDeterministicLLM,
  handleLangchainError,
} from "@/core/utils/llm.js";
import type { Diagnosis } from "@/core/models/Diagnosis.js";
import {
  PredefinedProcedureNames,
  ProcedureArrayJsonExampleString,
  ProcedureSchema,
  type Procedure,
  type ProcedureName,
} from "@/core/models/Procedure.js";
import type { Symptom } from "@/core/models/Symptom.js";
import { HumanMessage, SystemMessage } from "langchain";
import type { RequestContext } from "@/core/utils/context.js";
import type { Case } from "@/core/models/Case.js";
import type { Inconsistency } from "@/core/models/Inconsistency.js";

export async function generateProceduresCoT(
  diagnosis: Diagnosis,
  symptoms: Symptom[],
  userInstructions?: string,
  context?: RequestContext
): Promise<string> {
  const systemPrompt = buildPrompt(
    `You are an expert medical educator specializing in designing realistic clinical mock cases for medical students. 
Your task is to generate a step-by-step logical reasoning process (Chain of Thought) detailing EXACTLY HOW to order the required and correct Procedures.`,

    `The following symptoms are typical for the diagnosis. You may use a subset of them:
${symptoms.map((s, idx) => `${idx + 1}. ${s.name}: ${s.description ?? ""}`).join("\n")}`,

    `Instructions:
1. DO NOT generate the actual procedures yet. Only generate the thinking process which should be specific to the given diagnosis and a subset of symptoms.
2. Outline a sequential thought process.
3. Output ONLY the numbered reasoning steps, without any conversational filler.`
  );

  const userPrompt = buildPrompt(
    `Target Diagnosis: ${diagnosis.name} ${diagnosis.icd ?? ""}`,

    userInstructions
      ? `Additional Instructions: ${userInstructions}`
      : undefined
  );

  console.debug(
    `[GenerateProceduresCoT] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const stepsString: string = await retry(
      async (attempt: number) => {
        const result = await getDeterministicLLM({
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
          `[GenerateProceduresCoT] [Attempt ${attempt}] LLM raw Response:\n`,
          result.text
        );

        return result.text;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateProceduresCoT] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        publishEvent("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return stepsString;
  } catch (error) {
    console.error(`[GenerateProceduresCoT] Error:`, error);
    throw error;
  }
}

export async function generateProcedures(
  diagnosis: Diagnosis, // provided by the user
  config:
    | {
        cot: string;
        symptoms: Symptom[];
      }
    | {
        outline: string;
        case: Case;
      }
    | {
        case: Case;
        inconsistencies: Inconsistency[];
      },
  userInstructions?: string, // provided by the user
  procedureNameList: ProcedureName[] | undefined = PredefinedProcedureNames,
  context?: RequestContext
): Promise<Procedure[]> {
  const systemPrompt = buildPrompt(
    `You are an expert attending physician designing the diagnostic workup for a medical training simulator.
Your current task is to order the required Procedures ${"outline" in config ? "based on the provided Case Outline" : ""}.`,

    "cot" in config
      ? `The following symptoms are typical for the diagnosis. You may use a subset of them:
      ${config.symptoms.map((s, idx) => `${idx + 1}. ${s.name}: ${s.description ?? ""}`).join("\n")}

Think step by step:
    ${config.cot}`
      : undefined,

    "outline" in config
      ? `Order the procedures based on the approved outline.
In addition take the previously generated fields into account and decide which procedures are necessary to confirm the diagnosis based on the patient's presentation in the outline.
${JSON.stringify(config.case)}`
      : undefined,

    "inconsistencies" in config
      ? `The previous JSON generation contained clinical or logical inconsistencies. Regenerate the JSON, fixing the following issues while maintaining a realistic diagnostic pathway:

Original Procedures:
${JSON.stringify({ procedures: config.case.procedures })}

Inconsistencies to Fix:
${config.inconsistencies.map((i, idx) => `${idx + 1}. [Severity ${i.severity}] ${i.description}\n   Suggested Fix: ${i.suggestion}`).join("\n")}`
      : undefined,

    procedureNameList?.length
      ? `[RESTRICTED WORKUP]
You MUST ONLY select the necessary diagnostic procedures from the following approved list. Do not invent or recommend any procedures that are not explicitly listed below:
${procedureNameList.map((p) => `- ${p}`).join("\n")}`
      : `Generate a realistic list of standard procedures that should be performed to appropriately work up the patient and confirm the diagnosis.`,

    `Return ONLY a valid JSON object matching the schema below.
Schema:
${`{ "procedures": ${ProcedureArrayJsonExampleString()} }`}`,

    `Requirements:
- Workup Logic: The procedures must represent a realistic, standard-of-care diagnostic pathway (e.g., starting with baseline labs/imaging before moving to invasive confirmatory tests) to arrive at the Target Diagnosis.
- Terminology: Use specific, professional medical terminology for all orders (e.g., "Comprehensive Metabolic Panel" or "CT Angiography of the Chest with IV contrast" instead of "blood test" or "scan").
- Relevance: Every ordered procedure must have a clear clinical indication tied directly to the patient's presentation in the outline.
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
    `[GenerateProceduresFromOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  // Initialize cases to empty in case of failure
  try {
    const ProcedureSchemaWrapper = z.object({
      procedures: z.array(ProcedureSchema).describe("Generated procedures"),
    });

    const procedures: Procedure[] = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(ProcedureSchemaWrapper)
          .invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(
              userPrompt +
                (previousError
                  ? `\nPrevious generation error: ${previousError.message}`
                  : "")
            ),
          ])
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateProceduresFromOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        // const filteredProcedures = result.procedures.filter((p) =>
        //   procedureList
        //     ? procedureList.some((inputP) =>
        //         inputP.name.toLowerCase().includes(p.name.toLowerCase())
        //       )
        //     : true
        // );

        // if (filteredProcedures.length === 0) {
        //   throw new Error(
        //     `No generated procedures could be mapped to provided procedure list. Generated procedures: ${result.procedures
        //       .map((p) => p.name)
        //       .join(", ")}`
        //   );
        // }

        // return filteredProcedures;

        return result.procedures;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateProceduresFromOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        publishEvent("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return procedures;
  } catch (error) {
    console.error(`[GenerateProceduresFromOutline] Error:`, error);
    throw error;
  }
}

export async function generateProceduresFromEnglish(
  procedureNames: string[],
  language: ForeignLanguage,
  context?: RequestContext
): Promise<Record<string, string>> {
  const systemPrompt = buildPrompt(
    `Translate the provided procedures from English to a target language:`,
    `Return the procedures mapped to their translated part in a JSON
{ "translations": 
  [
  "translated procedure1",
  "translated procedure2",
  ...
  ]
}
ONLY return the JSON object, no additional text.`
  );

  const userPrompt = buildPrompt(
    `Target language: ${language}`,
    `Procedures to translate:
${procedureNames.map((p) => p.toLowerCase()).join("\n")}`
  );

  console.debug(
    `[GenerateProcedureTranslations] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return await retry(
    async (attempt: number, previousError?: Error) => {
      const response = await getDeterministicLLM(context?.llmConfig)
        .withStructuredOutput(z.object({ translations: z.array(z.string()) }))
        .invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(
            userPrompt +
              (previousError
                ? `\nPrevious generation error: ${previousError.message}`
                : "")
          ),
        ]);

      console.debug(
        `[GenerateProceduresFromEnglish] [Attempt ${attempt}] Generated procedure translations:`,
        response
      );

      if (response.translations.length !== procedureNames.length) {
        throw new Error(
          `The number of translated procedures does not match the number of English procedures. Expected ${procedureNames.length} but got ${response.translations.length}.`
        );
      }

      const result: Record<string, string> = {};
      procedureNames.forEach((engProc, idx) => {
        result[engProc] = response.translations[idx]!;
      });

      return result;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[GenerateProceduresFromEnglish] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      publishEvent("Generation Log", {
        msg,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
    }
  );
}
