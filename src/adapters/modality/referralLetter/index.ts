import z from "zod";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/shared/modality/ports.js";
import { requestLanguage } from "@/core/graph/shared/prompt/prompt.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { ModalityProviderModule } from "../resolve.js";
import { draftReferralLetters } from "./draft.js";
import {
  createMcpReferralLetterRenderer,
  probeReferralMcp,
  type ReferralLetterRenderer,
} from "./mcp.js";

const EnvSchema = z.object({
  /** AetioReferral's MCP endpoint, e.g. http://localhost:8000/mcp. */
  REFERRAL_MCP_URL: z.url(),
});

/** Drafts each planned `alt` into letter fields (LLM), then renders each as a PDF. */
export function referralLetterProvider(
  runtime: GraphRuntime,
  render: ReferralLetterRenderer,
  description: string
): ModalityProvider<unknown> {
  return defineModalityProvider({
    id: "referral_letter",
    mime: "application/pdf",
    description,
    inputSchema: z.object({}),
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
        letters.map((letter) => render(letter, language, context.signal))
      );
    },
  });
}

/** PDF referral letters, rendered by AetioReferral over MCP. */
export const referralLetterModule: ModalityProviderModule<typeof EnvSchema> = {
  id: "referral_letter",
  fields: {
    chiefComplaint: {
      mode: "optional",
      description:
        "The referring physician's referral letter as a printed PDF document (who referred to which specialty, why, the referrer's findings, any suspected diagnosis as written), rendered from the part's alt (no input needed: pass {}). Prefer it over the plain-text \"referral\" provider for the referral part.",
    },
  },
  env: EnvSchema,
  probe: (env) => probeReferralMcp(env.REFERRAL_MCP_URL),
  create: (env, runtime, description) =>
    referralLetterProvider(
      runtime,
      createMcpReferralLetterRenderer(env.REFERRAL_MCP_URL),
      description
    ),
};
