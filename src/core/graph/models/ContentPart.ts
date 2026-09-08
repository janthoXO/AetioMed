import z from "zod";

/**
 * One typed, additive part of a multimodal field (`chiefComplaint`, an
 * `anamnesis[].answer`, a `procedures[].result`). A field's full value is an
 * ORDERED array of these parts that together *compose* the value — it is
 * **not** a list of alternative renditions to choose between. Order is
 * therefore meaningful and must survive every fan-in, persistence and
 * translation step, and an empty array is never a valid field value: a field
 * that exists has at least one part, a field that does not exist is absent
 * (enforced by `ContentPartsSchema`'s `.min(1)`).
 *
 * `alt` is the render request, retained — the plain-text input a provider
 * was called with (issue 13), not a description the provider produced.
 * Every part therefore carries text *by construction*: there is nothing to
 * validate and no provider obligation to enforce.
 */
export const ContentPartSchema = z.object({
  /** MIME type of `value`. */
  type: z.string(),
  /** The rendered artifact. */
  value: z.instanceof(Uint8Array),
  /** Plain text: what this part conveys — the render request, retained. */
  alt: z.string(),
});

export type ContentPart = z.infer<typeof ContentPartSchema>;

/**
 * A field's full value: an ordered, non-empty array of additive parts. See
 * `ContentPartSchema` above for the additive-parts semantics.
 */
export const ContentPartsSchema = z.array(ContentPartSchema).min(1);

/**
 * The only constructor for a text part. `value` is *derived* from `alt`,
 * never authored independently — that is what makes the uniform
 * `ContentPart` shape safe: translation touches `alt` only and re-derives
 * `value`, so the two cannot drift (see `textOf`).
 */
export function textPart(alt: string): ContentPart {
  return {
    type: "text/plain",
    alt,
    value: new TextEncoder().encode(alt),
  };
}

/**
 * The only path from content parts to a prompt: joins every part's `alt`.
 * No MIME branching — a non-text part contributes its `alt` exactly like a
 * text part does, which is what makes this safe to call on any
 * `ContentPart[]` without an `isText()` check anywhere.
 *
 * Bytes must never reach a prompt: prompt builders take `string`, never
 * `ContentPart[]` (issue 11 §4).
 */
export function textOf(parts: ContentPart[]): string {
  return parts.map((p) => p.alt).join("\n\n");
}
