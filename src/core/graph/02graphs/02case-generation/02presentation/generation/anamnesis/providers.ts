import z from "zod";
import { encodeText } from "@/core/graph/models/ContentPart.js";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/modality/ports.js";
import { renderAnamnesisTexts } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

const TextInputSchema = z.object({ instruction: z.string().min(1) });

/**
 * The anamnesis field's registry (issue 21 §4): today, exactly one
 * provider — a thin adapter over `renderAnamnesisTexts`
 * (`03aigateway/anamnesis.aigateway.ts`), which is where the prompt and the
 * LLM call actually live, per the numbered-layer rule. It calls that
 * gateway function ONCE with the whole batch it was handed — one LLM call
 * for every category's instruction the plan produced, not one call per
 * category, which is the batching property this design exists for.
 */
export function createAnamnesisProviders(
  runtime: GraphRuntime
): ModalityProvider<unknown>[] {
  return [
    defineModalityProvider({
      id: "text",
      mime: "text/plain",
      description:
        "Plain patient-voice text, rendered from a self-contained natural-language instruction.",
      inputSchema: TextInputSchema,
      render: async (batch, context) => {
        const texts = await renderAnamnesisTexts(
          runtime,
          batch.map((item) => item.instruction),
          context
        );
        return texts.map(encodeText);
      },
    }),
  ];
}
