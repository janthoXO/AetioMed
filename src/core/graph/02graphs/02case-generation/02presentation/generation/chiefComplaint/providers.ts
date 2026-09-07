import z from "zod";
import { encodeText } from "@/core/graph/models/ContentPart.js";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/modality/ports.js";
import { renderChiefComplaintTexts } from "@/core/graph/03aigateway/chiefComplaint.aigateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

const TextInputSchema = z.object({ instruction: z.string().min(1) });

/**
 * The chief complaint field's registry (issue 21 §4): today, exactly one
 * provider — a thin adapter over `renderChiefComplaintTexts`
 * (`03aigateway/chiefComplaint.aigateway.ts`), which is where the prompt and
 * the LLM call actually live, per the numbered-layer rule (a provider that
 * built its own prompt would violate it). It calls that gateway function
 * ONCE with the whole batch it was handed — the batching is the point of
 * `ModalityProvider.render`'s contract, so a loop of single calls here would
 * defeat the design. A future non-text provider (a transfer-slip PDF, say)
 * slots into this array without touching the planner or the subgraph.
 */
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
