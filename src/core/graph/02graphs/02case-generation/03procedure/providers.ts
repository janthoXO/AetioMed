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
 * Procedure-result registry: one text provider, thin adapter over
 * `renderProcedureResultTexts` (prompt + LLM live there). One gateway call
 * per batch; `render_results` batches all procedures.
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
