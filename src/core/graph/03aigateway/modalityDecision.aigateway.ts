import z from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import type { GraphRuntime } from "../runtime.js";
import type { ModalityRenderRequest } from "../modality/ports.js";

export type ModalityDecisionUnit = { key: string; text: string };
export type ModalityDecisionPlan = Record<string, ModalityRenderRequest[]>;

/**
 * `decide_modality`'s planning call (issue 13 §2/§4): only ever invoked when
 * the modality registry holds more than one entry — see
 * `02presentation/generation/pipeline.ts`'s `buildContentPartsSubgraph`.
 * With exactly one entry the composition is synthesized directly
 * (`modality/pipeline.ts`'s `defaultPlanFor`) and this is never called; that
 * is also why no non-text modality provider exists yet in production, and
 * this function's real-LLM path is exercised by tests only, via a fake
 * `LlmPort`.
 *
 * Plans, for every content unit (one per field, or — for anamnesis — one
 * per category), an ORDERED list of render requests, each `{ modality, alt }`,
 * drawn only from the MIME types the registry can actually produce. `alt` is
 * the render request itself, in plain text describing what that part should
 * convey — a provider renders it verbatim, it never invents its own
 * description (issue 11 §12b, issue 13 §3).
 *
 * `"user-facing"` audience: a planned `text/plain` request's `alt` can
 * become the field's entire rendered value (via the text provider), so it
 * gets the same language directive `generate_content`'s own gateway calls
 * do.
 */
export async function decideModalityComposition(
  runtime: GraphRuntime,
  units: ModalityDecisionUnit[],
  availableModalities: string[],
  context?: RequestContext
): Promise<ModalityDecisionPlan> {
  const unitKeys = units.map((u) => u.key) as [string, ...string[]];
  const modalityLiterals = availableModalities as [string, ...string[]];

  const RequestSchema = z.object({
    modality: z
      .enum(modalityLiterals)
      .describe("MIME type this part should be rendered into"),
    alt: z
      .string()
      .min(1)
      .describe("Plain text describing what this part should convey"),
  });

  const PlanSchema = z.object({
    plans: z
      .array(
        z.object({
          key: z.enum(unitKeys).describe("The content unit this plan is for"),
          requests: z
            .array(RequestSchema)
            .min(1)
            .describe(
              "Ordered render requests composing this unit's final value"
            ),
        })
      )
      .length(units.length),
  });

  const systemPrompt = buildSystemPrompt(
    runtime,
    "user-facing",
    section(
      "Role",
      `You are planning how to render already-generated case content into one or more modalities for a medical training simulator.
Each "unit" below already has its final canonical text — you are not inventing new facts, only deciding how to present them.`
    ),

    section(
      "Requirements",
      `- For every unit, return at least one render request.
- Each request's "alt" is plain text describing exactly what that rendered part should convey — a provider will render this text verbatim into the chosen modality, so it must be self-contained.
- Prefer one "text/plain" request carrying the unit's full text unless another available modality would clearly add value.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      "Available modalities (MIME types)",
      availableModalities.join(", ")
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:\n${renderSchemaForPrompt(PlanSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section(
      "Units to plan",
      units.map((u) => `### ${u.key}\n${u.text}`).join("\n\n")
    )
  );

  console.debug(
    `[DecideModalityComposition] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const plans = await retry(
    async (attempt: number, previousError?: Error) => {
      const result = await runtime.llm
        .for(
          { role: "generator", temperature: "deterministic" },
          context?.llmConfig
        )
        .withStructuredOutput(PlanSchema)
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
        `[DecideModalityComposition] [Attempt ${attempt}] LLM raw Response:\n`,
        JSON.stringify(result, null, 2)
      );

      return result.plans;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[DecideModalityComposition] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );

  return Object.fromEntries(plans.map((p) => [p.key, p.requests]));
}
