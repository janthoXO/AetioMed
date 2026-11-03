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

/** Chief complaint registry: thin adapters over `gateway.ts` (prompts and LLM calls live there), each calling it ONCE with its whole batch per `ModalityProvider.render` contract. A referral is its own part (#219): no frontend slot of its own. Pluggable providers (e.g. `referral_letter`) come from `adapters/modality/`. */
export function createChiefComplaintProviders(
  runtime: GraphRuntime
): ModalityProvider<unknown>[] {
  const textProvider = (
    id: string,
    description: string,
    voice: "chart" | "referral"
  ) =>
    defineModalityProvider({
      id,
      mime: "text/plain",
      description,
      inputSchema: TextInputSchema,
      render: async (batch, context) => {
        const texts = await renderChiefComplaintTexts(
          runtime,
          requestLanguage(),
          batch.map((item) => item.alt),
          context,
          voice
        );
        return texts.map(encodeText);
      },
    });
  return [
    textProvider(
      "text",
      "Plain clinical-chart text, rendered from the part's alt (no input needed: pass {}).",
      "chart"
    ),
    textProvider(
      "referral",
      "The referring physician's referral note (who referred, why, any suspected diagnosis as written), rendered from the part's alt (no input needed: pass {}).",
      "referral"
    ),
  ];
}
