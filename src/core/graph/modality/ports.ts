import z from "zod";
import type { RequestContext } from "@/core/graph/utils/context.js";

/** Exactly `RequestContext`: providers may call an LLM, and under `ALLOW_LLMS` `llmConfig` is the only provider/model source. */
export type RenderContext = RequestContext;

/**
 * One planner-specified request: provider, its typed input (opaque here;
 * `inputSchema` constrains it), planner-authored `alt`. Safety: `textOf()`
 * feeds blinded solver, `matchDiagnosis` and plan judge, so a provider-authored
 * `alt` could inject facts. Provider sees only `input`.
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
 * Source of rendered bytes for one modality, addressed by `id` in the
 * planner grammar. No LLM assumption: text or non-text (image model) alike.
 *
 * `mime` fixed per provider; planner picks by `id`, never chooses MIME.
 *
 * `render`: batch in, batch out, one buffer per input in INPUT order, so a
 * provider chooses its own splitting; `renderPlan` zips `batch[i]` to `result[i]`.
 */
export interface ModalityProvider<I = unknown> {
  readonly id: string;
  readonly mime: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  render(batch: I[], ctx: RenderContext): Promise<Uint8Array<ArrayBuffer>[]>;
}

/**
 * Erases `ModalityProvider<I>`'s generic so heterogeneous providers share one
 * array. Sound at runtime: `render` re-parses the batch with
 * `inputSchema.array()`, so a foreign input shape fails at the provider boundary.
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
