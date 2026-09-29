import { boundLanguage } from "@/core/graph/shared/prompt/prompt.js";
import z from "zod";
import { encodeText } from "@/core/graph/shared/domain/ContentPart.js";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/shared/modality/ports.js";
import { renderAnamnesisTexts } from "./gateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

const TextInputSchema = z.object({ instruction: z.string().min(1) });

/** Anamnesis registry: one text provider, thin adapter over `renderAnamnesisTexts` (`gateway.ts`; prompt and LLM call live there). Calls it ONCE with whole batch, not per category. */
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
          boundLanguage(runtime),
          batch.map((item) => item.instruction),
          context
        );
        return texts.map(encodeText);
      },
    }),
  ];
}
