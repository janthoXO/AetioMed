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
 * `alt` is a short description of what the part conveys — authored by the
 * planner (issue 21 §1), not derived from `value`. `value` is the rendered
 * artifact itself, and for a text MIME type that *is* the content — prose,
 * not a label. The two are independent fields with independent authors;
 * `textOfPart`/`textOf` below are what reconcile them back into the single
 * string a prompt or trace needs.
 */
export const ContentPartSchema = z.object({
  /** MIME type of `value`. */
  type: z.string(),
  /** The rendered artifact. */
  value: z.instanceof(Uint8Array),
  /** Plain text: a short description of what this part conveys. */
  alt: z.string(),
});

export type ContentPart = z.infer<typeof ContentPartSchema>;

/**
 * A field's full value: an ordered, non-empty array of additive parts. See
 * `ContentPartSchema` above for the additive-parts semantics.
 */
export const ContentPartsSchema = z.array(ContentPartSchema).min(1);

/**
 * UTF-8 encode a string into a text part's `value`. This used to be hidden
 * behind `textPart(alt)`, a constructor whose name asserted `value` was
 * *derived* from `alt` — that invariant no longer holds (see the schema
 * comment above), so callers now build the `{ type, value, alt }` object
 * explicitly at each call site and use this only for the `value` half.
 */
export function encodeText(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

/**
 * MIME-dispatched extraction of one part's text content. This is the
 * extension point for a future non-text MIME whose meaning lives in
 * `value` rather than `alt` (e.g. `application/pdf`): add a row here, not a
 * runtime registration API — this repo deleted its extension system on
 * purpose (#115), and a mutable global registry of extractors would
 * reintroduce exactly that shape. A `const` table is the right size for
 * "a handful of MIME classes, known at build time."
 *
 * Falls back to `part.alt` for any MIME with no matching row, so a part of
 * an unrecognised type still contributes *something* legible rather than
 * throwing or silently vanishing.
 *
 * `part.value` is trusted to be a real `Uint8Array` here, and that trust is
 * enforced upstream rather than defended against here: a `Send` payload
 * round-trips through JSON and would hand this an index-keyed plain object
 * instead, so **no `Send` payload may carry `ContentPart` bytes** (issue 21;
 * the two translation phases use plain edges for exactly this reason). A
 * silent repair at this one read site would have been worse than none — the
 * wire codec, the size ceiling and every non-text reader would still have
 * seen the corrupted object.
 */
const TEXT_EXTRACTORS: {
  matches: (mime: string) => boolean;
  extract: (part: ContentPart) => string;
}[] = [
  {
    matches: (mime) => mime.startsWith("text/"),
    extract: (part) => new TextDecoder().decode(part.value),
  },
];

/**
 * The text content of one part, MIME-dispatched via {@link TEXT_EXTRACTORS}.
 * For today's only registered MIME class (`text/*`) this decodes `value`;
 * for anything else it falls back to `alt`.
 */
export function textOfPart(part: ContentPart): string {
  const extractor = TEXT_EXTRACTORS.find((row) => row.matches(part.type));
  return extractor ? extractor.extract(part) : part.alt;
}

/**
 * The only path from content parts to a prompt: joins every part's text
 * content, MIME-dispatched via {@link textOfPart}.
 *
 * Bytes must never reach a prompt: prompt builders take `string`, never
 * `ContentPart[]` (issue 11 §4).
 */
export function textOf(parts: ContentPart[]): string {
  return parts.map(textOfPart).join("\n\n");
}
