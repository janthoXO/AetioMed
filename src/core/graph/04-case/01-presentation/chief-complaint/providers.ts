import { requestLanguage } from "@/core/graph/shared/prompt/prompt.js";
import z from "zod";
import { encodeText } from "@/core/graph/shared/domain/ContentPart.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/shared/modality/ports.js";
import {
  draftReferralLetters,
  renderChiefComplaintTexts,
  type ReferralLetter,
} from "./gateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

/** Empty: the text provider renders the part's `alt`. */
const TextInputSchema = z.object({});

/** Renders one referral letter as a PDF in `language`. Adapter: AetioReferral over MCP (`adapters/referral/`). */
export type ReferralLetterRenderer = (
  letter: ReferralLetter,
  language: Language,
  signal?: AbortSignal
) => Promise<Uint8Array<ArrayBuffer>>;

/** Chief complaint registry: thin adapters over `gateway.ts` (prompts and LLM calls live there), each calling it ONCE with its whole batch per `ModalityProvider.render` contract. A referral is its own part (#219): no frontend slot of its own. `referral_letter` is registered only when the deployment has a `ReferralLetterRenderer`. */
export function createChiefComplaintProviders(
  runtime: GraphRuntime,
  renderReferralLetter?: ReferralLetterRenderer
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
  const providers = [
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
  if (renderReferralLetter) {
    providers.push(
      defineModalityProvider({
        id: "referral_letter",
        mime: "application/pdf",
        description:
          "The referring physician's referral letter as a printed PDF document (who referred to which specialty, why, the referrer's findings, any suspected diagnosis as written), rendered from the part's alt (no input needed: pass {}).",
        inputSchema: TextInputSchema,
        render: async (batch, context) => {
          // AetioReferral never translates content: draft in the request language.
          const language = requestLanguage() ?? "en";
          const letters = await draftReferralLetters(
            runtime,
            language,
            batch.map((item) => item.alt),
            context
          );
          return Promise.all(
            letters.map((letter) =>
              renderReferralLetter(letter, language, context.signal)
            )
          );
        },
      })
    );
  }
  return providers;
}
