import z from "zod";
import type { RequestContext } from "@/core/graph/utils/context.js";

/**
 * A render request planned by `decide_modality` (or synthesized directly
 * when the registry has exactly one entry — see `pipeline.ts`): plain text
 * describing what one part should convey, plus the MIME type it should be
 * rendered into. `alt` is an INPUT to the provider, never an output — see
 * `ContentPart.ts`'s doc comment and issue 13 §2/§3.
 *
 * A zod schema (rather than a plain type, like `RenderContext` below)
 * because it lives on the field-content subgraphs' state (the `modalityPlan`
 * channel in `02presentation/generation/chiefComplaintGraph.ts` and
 * `anamnesisGraph.ts`).
 */
export const ModalityRenderRequestSchema = z.object({
  modality: z.string(),
  alt: z.string(),
});

export type ModalityRenderRequest = z.infer<typeof ModalityRenderRequestSchema>;

/**
 * `RenderContext` is exactly `RequestContext` — not a signal-only shape.
 * Take the lesson from issue 14 (`medicalBasis/ports.ts`'s `MedicalBasisProvider`
 * doc comment): a provider may call an LLM (an image provider going out to a
 * diffusion model, say), and under `ALLOW_LLMS` the request's `llmConfig` is
 * the only source of provider/model. A signal-only port would have been a
 * silent regression the first time a real non-text provider showed up.
 */
export type RenderContext = RequestContext;

/**
 * A source of rendered bytes for one modality. Deliberately carries **no
 * LLM assumption**: the text provider (`providers/text.ts`) is the
 * degenerate case — `utf8(alt)`, no model call at all, because the text was
 * already produced by `generate_content` (issue 13 §1/§3) — while an image
 * provider might call a diffusion model over MCP. Both satisfy this same
 * interface, which is the entire point of the byte carrier.
 *
 * `produces` declares the MIME types this provider can emit; the registry
 * (`registry.ts`) and the pipeline (`pipeline.ts`) look providers up by MIME
 * type, never by `id` — `id` is for logging only.
 */
export interface ModalityProvider {
  readonly id: string;
  readonly produces: string[];
  // Pinned to the `ArrayBuffer`-backed `Uint8Array` — the same concrete
  // shape `ContentPartSchema`'s `z.instanceof(Uint8Array)` (`ContentPart.ts`)
  // infers — so a provider's bytes assign straight into a `ContentPart`
  // with no cast at the call site (`pipeline.ts`'s `renderRequests`).
  render(alt: string, ctx: RenderContext): Promise<Uint8Array<ArrayBuffer>>;
}
