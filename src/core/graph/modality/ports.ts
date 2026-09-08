import z from "zod";
import type { RequestContext } from "@/core/graph/utils/context.js";

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
 * One request the planner has fully specified: which provider renders it,
 * that provider's own typed input (opaque here — the provider's
 * `inputSchema` is what actually constrains it), and the planner-authored
 * `alt`. `alt` is a safety property, not a stylistic one (issue 21 §1):
 * `textOf()` feeds the blinded solver, `matchDiagnosis` and the plan judge,
 * so a provider that could author its own `alt` could inject facts into the
 * solver's blinded view. A provider only ever sees `input`.
 */
export const PlannedPartSchema = z.object({
  provider: z.string(),
  input: z.unknown(),
  alt: z.string().min(1),
});
export type PlannedPart = z.infer<typeof PlannedPartSchema>;

/** One field's whole plan: content-unit key -> its ORDERED render requests. */
export type ModalityPlan = Record<string, PlannedPart[]>;

/**
 * A source of rendered bytes for one modality, addressed by the planner's
 * grammar via `id` (`composition.ts`'s `buildCompositionSchema`). Carries
 * **no LLM assumption**: a provider may be the degenerate text case (one
 * LLM call rendering a batch of instructions verbatim) or a future
 * non-text provider (an image model reached over MCP, say) — both satisfy
 * this same interface.
 *
 * `mime` is fixed per provider — the registry owns it, never the plan
 * (issue 21 §1): the planner only ever picks a provider by `id` and
 * supplies its `input`, it never chooses the MIME type directly.
 *
 * `render` is **batch in, batch out**: one buffer per input, in INPUT
 * order. This is what lets a provider decide its own splitting — the
 * anamnesis text provider makes ONE LLM call for every category it was
 * handed, not one call per category (issue 21 §3) — while the pipeline
 * (`pipeline.ts`'s `renderPlan`) still reassembles deterministically by
 * zipping `batch[i]` back to `result[i]`.
 */
export interface ModalityProvider<I = unknown> {
  readonly id: string;
  readonly mime: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  render(batch: I[], ctx: RenderContext): Promise<Uint8Array<ArrayBuffer>[]>;
}

/**
 * Erases a `ModalityProvider<I>`'s generic so heterogeneous providers (a
 * text provider, an image provider, …) can share one array
 * (`ModalityRegistries`, `registry.ts`) without every caller re-deriving a
 * union type. The erasure is kept SOUND at runtime, not just papered over
 * at the type level: `render` is wrapped to `spec.inputSchema.array().parse(batch)`
 * before delegating, so a caller that hands `renderPlan` a batch this
 * provider never declared gets a Zod error at the provider boundary
 * instead of a provider silently misinterpreting someone else's input
 * shape.
 */
export function defineModalityProvider<I>(
  spec: ModalityProvider<I>
): ModalityProvider<unknown> {
  return {
    id: spec.id,
    mime: spec.mime,
    description: spec.description,
    inputSchema: spec.inputSchema as z.ZodType<unknown>,
    render: (batch, ctx) =>
      spec.render(spec.inputSchema.array().parse(batch), ctx),
  };
}
