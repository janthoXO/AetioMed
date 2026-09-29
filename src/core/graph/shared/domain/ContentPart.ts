import z from "zod";

/**
 * One additive part of a multimodal field (`chiefComplaint`,
 * `anamnesis[].answer`, `procedures[].result`). Field value is an ORDERED
 * array of parts that together *compose* it, **not** alternative renditions.
 * Order must survive fan-in and translation. Empty array invalid (`.min(1)`):
 * existing field has at least one part, else absent.
 *
 * `alt`: short description, planner-authored, independent of `value`.
 * `value`: rendered artifact; for text MIME it is the prose content.
 * `textOfPart`/`textOf` reconcile both into prompt text.
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

/** Field value: ordered, non-empty array of additive parts. */
export const ContentPartsSchema = z.array(ContentPartSchema).min(1);

/** UTF-8 encode a string into a text part's `value`. `alt` is set separately by caller. */
export function encodeText(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

/**
 * MIME-dispatched text extraction. Add a row for a new MIME whose meaning
 * lives in `value` (e.g. `application/pdf`); no runtime registry. Unmatched
 * MIME falls back to `part.alt`.
 *
 * `part.value` must be a real `Uint8Array`: **no `Send` payload may carry
 * `ContentPart` bytes** (JSON round-trip yields an index-keyed object).
 * Translation phases use plain edges. Do not repair here.
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

/** Text of one part via {@link TEXT_EXTRACTORS}: `text/*` decodes `value`, else `alt`. */
export function textOfPart(part: ContentPart): string {
  const extractor = TEXT_EXTRACTORS.find((row) => row.matches(part.type));
  return extractor ? extractor.extract(part) : part.alt;
}

/** Only path from content parts to a prompt: joins {@link textOfPart} of each. Prompt builders take `string`, never `ContentPart[]`. */
export function textOf(parts: ContentPart[]): string {
  return parts.map(textOfPart).join("\n\n");
}
