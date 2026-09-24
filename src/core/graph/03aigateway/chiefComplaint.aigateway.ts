import z from "zod";
import { handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import type { GraphRuntime } from "../runtime.js";
import {
  buildCompositionSchema,
  describeProviders,
} from "../modality/composition.js";
import type { ModalityPlan, ModalityProvider } from "../modality/ports.js";

/** Chief complaint has one content unit, no per-category split. */
export const CHIEF_COMPLAINT_UNIT_KEY = "chiefComplaint";

/**
 * Plans chief complaint rendering: one LLM call returning ordered render
 * requests against the field's providers. `alt` authored here, never by a
 * provider: a provider-authored `alt` could inject facts into the blinded
 * solver's view.
 */
export async function planChiefComplaint(
  runtime: GraphRuntime,
  diagnosis: Diagnosis,
  outline: string,
  providers: ModalityProvider<unknown>[],
  userInstructions?: string,
  context?: RequestContext
): Promise<ModalityPlan> {
  const schema = buildCompositionSchema(providers, [CHIEF_COMPLAINT_UNIT_KEY]);

  // User-facing: planned `alt`/instruction become user-visible content.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "user-facing",
    section(
      "Role",
      `You are an expert attending physician documenting a patient's presentation for a medical training simulator.
Your current task is to plan how the Chief Complaint facts from the provided Case Outline should be rendered. The outline is the single source of truth — you do not decide any clinical facts yourself, only how to present them.`
    ),

    section(
      "Requirements",
      `- The chief complaint is written from the perspective of a medical professional writing in a clinical chart: concise, objective clinical language and standard medical terminology (e.g., "acute onset dyspnea" instead of "shortness of breath").
- Use ONLY the facts specified in the outline (chief complaint, demographics, symptom timeline). Do not add clinical facts not present in the outline.
- Plan exactly one content unit, keyed "${CHIEF_COMPLAINT_UNIT_KEY}".
- Prefer a single request against the "text" provider carrying the whole chief complaint, unless another available provider would clearly add value.
- Each request's "alt" is a self-contained instruction describing exactly what that rendered part should convey, in the clinical-chart voice above — a provider renders it verbatim, it never invents facts.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section("Available providers", describeProviders(providers)),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(schema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section("Case outline", outline),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[PlanChiefComplaint] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const plans = await retry(
    async (attempt: number, previousError?: Error) => {
      const result = (await runtime.llm
        .for({ role: "generator", temperature: "balanced" }, context?.llmConfig)
        .withStructuredOutput(schema)
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
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch((error) => {
          handleLangchainError(error);
        })) as { plans: { key: string; requests: ModalityPlan[string] }[] };

      console.debug(
        `[PlanChiefComplaint] [Attempt ${attempt}] LLM raw Response:\n`,
        JSON.stringify(result, null, 2)
      );

      return result.plans;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[PlanChiefComplaint] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );

  return Object.fromEntries(plans.map((p) => [p.key, p.requests]));
}

/**
 * Text rendering for chief complaint: whole batch of planner instructions in
 * ONE LLM call, per `ModalityProvider.render` batch contract. Renders exactly
 * what given, invents nothing.
 */
export async function renderChiefComplaintTexts(
  runtime: GraphRuntime,
  instructions: string[],
  context?: RequestContext
): Promise<string[]> {
  const schema = z.object({
    texts: z
      .array(z.string().min(1))
      .length(instructions.length)
      .describe(
        "Rendered chief complaint text, one per instruction, in the same order"
      ),
  });

  const systemPrompt = buildSystemPrompt(
    runtime,
    "user-facing",
    section(
      "Role",
      `You are an expert attending physician documenting a patient's presentation for a medical training simulator.
You will be given one or more instructions, each fully describing one chief complaint text to render. Render EXACTLY what each instruction says — you do not decide clinical facts, only wording.`
    ),

    section(
      "Requirements",
      `- Write in clinical-chart voice: concise, objective clinical language and standard medical terminology (e.g., "acute onset dyspnea" instead of "shortness of breath").
- Render each instruction into its own text; invent nothing beyond what the instruction states.
- Return exactly ${instructions.length} text(s), in the same order as the instructions.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(schema)}`
    )
  );

  const userPrompt = buildPrompt(
    section(
      "Instructions to render",
      instructions
        .map((instruction, i) => `### ${i + 1}\n${instruction}`)
        .join("\n\n")
    )
  );

  console.debug(
    `[RenderChiefComplaintTexts] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const result = await runtime.llm
        .for({ role: "generator", temperature: "balanced" }, context?.llmConfig)
        .withStructuredOutput(schema)
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
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch((error) => {
          handleLangchainError(error);
        });

      console.debug(
        `[RenderChiefComplaintTexts] [Attempt ${attempt}] LLM raw Response:\n`,
        JSON.stringify(result, null, 2)
      );

      return result.texts;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[RenderChiefComplaintTexts] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );
}
