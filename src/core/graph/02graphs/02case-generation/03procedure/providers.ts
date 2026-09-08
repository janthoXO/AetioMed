import z from "zod";
import { encodeText } from "@/core/graph/models/ContentPart.js";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/modality/ports.js";
import { renderProcedureResultTexts } from "@/core/graph/03aigateway/procedures.aigateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

const TextInputSchema = z.object({ instruction: z.string().min(1) });

/**
 * The procedure-result field's registry (issue 21 §4/§7): today, exactly one
 * provider — a thin adapter over `renderProcedureResultTexts`
 * (`03aigateway/procedures.aigateway.ts`), which is where the prompt and the
 * LLM call actually live, per the numbered-layer rule. It calls that gateway
 * function ONCE with the whole batch it was handed — `render_results`
 * (`03procedure/index.ts`) flattens every planned part across EVERY
 * procedure before calling `renderPlan`, so this one call covers the whole
 * case's procedure results, not one call per procedure.
 */
export function createProcedureResultProviders(
  runtime: GraphRuntime
): ModalityProvider<unknown>[] {
  return [
    defineModalityProvider({
      id: "text",
      mime: "text/plain",
      description:
        "Plain clinical procedure-result text, rendered from a self-contained natural-language instruction.",
      inputSchema: TextInputSchema,
      render: async (batch, context) => {
        const texts = await renderProcedureResultTexts(
          runtime,
          batch.map((item) => item.instruction),
          context
        );
        return texts.map(encodeText);
      },
    }),
  ];
}
