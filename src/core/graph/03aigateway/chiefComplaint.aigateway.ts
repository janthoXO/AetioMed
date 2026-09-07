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

/** The chief complaint's one content unit — there is no per-category split
 * here, unlike anamnesis (`anamnesis.aigateway.ts`). */
export const CHIEF_COMPLAINT_UNIT_KEY = "chiefComplaint";

/**
 * Plans the chief complaint's rendering (issue 21 §1/§5): ONE LLM call that
 * still decides the case content — it reads the outline exactly as the old
 * direct generator did (the Role/Requirements below are that generator's
 * prompt, kept verbatim in substance) — but instead of returning prose
 * directly, it returns an ORDERED list of render requests against the
 * field's registered providers. `alt` is authored HERE, by the planner,
 * never by a provider (issue 21 §1): a provider that could author its own
 * `alt` could inject facts into the blinded solver's view down the line.
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

  // User-facing (issue 09 §3): a planned `alt`/instruction both become
  // user-visible content once rendered.
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
 * The chief complaint's TEXT-rendering call (issue 21 §4): renders an
 * entire batch of planner-authored instructions in ONE LLM call — the
 * batching is the whole point of `ModalityProvider.render`'s batch-in/
 * batch-out contract (`modality/ports.ts`). Keeps the old direct
 * generator's tuned clinical-chart voice; only the FACTS now arrive via
 * each instruction, so the renderer is told explicitly to render exactly
 * what it's given and invent nothing.
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
