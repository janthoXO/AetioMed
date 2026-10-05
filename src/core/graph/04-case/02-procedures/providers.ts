import { requestLanguage } from "@/core/graph/shared/prompt/prompt.js";
import z from "zod";
import { encodeText } from "@/core/graph/shared/domain/ContentPart.js";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/shared/modality/ports.js";
import { renderProcedureResultTexts } from "./results.gateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

/** Empty: the text provider renders the part's `alt`. */
const TextInputSchema = z.object({});

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
        "Plain clinical procedure-result text, rendered from the part's alt (no input needed: pass {}).",
      inputSchema: TextInputSchema,
      render: async (batch, context) => {
        const texts = await renderProcedureResultTexts(
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
