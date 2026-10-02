import { requestLanguage } from "@/core/graph/shared/prompt/prompt.js";
import z from "zod";
import { encodeText } from "@/core/graph/shared/domain/ContentPart.js";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/shared/modality/ports.js";
import { renderChiefComplaintTexts } from "./gateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

/** Empty: the text provider renders the part's `alt`. */
const TextInputSchema = z.object({});

/** Chief complaint registry: one text provider, thin adapter over `renderChiefComplaintTexts` (`gateway.ts`; prompt and LLM call live there). Calls it ONCE with whole batch per `ModalityProvider.render` contract. Non-text providers slot into this array. */
export function createChiefComplaintProviders(
  runtime: GraphRuntime
): ModalityProvider<unknown>[] {
  return [
    defineModalityProvider({
      id: "text",
      mime: "text/plain",
      description:
        "Plain clinical-chart text, rendered from the part's alt (no input needed: pass {}).",
      inputSchema: TextInputSchema,
      render: async (batch, context) => {
        const texts = await renderChiefComplaintTexts(
          runtime,
          requestLanguage(),
          batch.map((item) => item.alt),
          context
        );
        return texts.map(encodeText);
      },
    }),
  ];
}
