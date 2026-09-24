import z from "zod";
import { encodeText } from "@/core/graph/models/ContentPart.js";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/modality/ports.js";
import { renderChiefComplaintTexts } from "@/core/graph/03aigateway/chiefComplaint.aigateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

const TextInputSchema = z.object({ instruction: z.string().min(1) });

/** Chief complaint registry: one text provider, thin adapter over `renderChiefComplaintTexts` (`03aigateway/chiefComplaint.aigateway.ts`; prompt and LLM call live there). Calls it ONCE with whole batch per `ModalityProvider.render` contract. Non-text providers slot into this array. */
export function createChiefComplaintProviders(
  runtime: GraphRuntime
): ModalityProvider<unknown>[] {
  return [
    defineModalityProvider({
      id: "text",
      mime: "text/plain",
      description:
        "Plain clinical-chart text, rendered from a self-contained natural-language instruction.",
      inputSchema: TextInputSchema,
      render: async (batch, context) => {
        const texts = await renderChiefComplaintTexts(
          runtime,
          batch.map((item) => item.instruction),
          context
        );
        return texts.map(encodeText);
      },
    }),
  ];
}
