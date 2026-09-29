import z from "zod";

/**
 * One additive part of a multimodal field (`chiefComplaint`,
 * `anamnesis[].answer`, `procedures[].result`). Field value is an ORDERED
 * array of parts that together *compose* it, **not** alternative renditions.
 * Order must survive fan-in and translation. Empty array invalid (`.min(1)`):
 * existing field has at least one part, else absent.
 *
 * `alt`: planner-authored, self-contained content of the part in the working
 * language (English with sandwich on). The only thing machines read
 * (blinded solver, `matchDiagnosis`); a provider may read it, never author it.
 * `value`: rendered artifact for humans; for text MIME it is the prose content.
 */
export const ContentPartSchema = z.object({
  /** MIME type of `value`. */
  type: z.string(),
  /** The rendered artifact. */
  value: z.instanceof(Uint8Array),
  /** Plain text: self-contained content of this part, in the working language. */
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
 * Only path from content parts to a prompt: their `alt`s joined, whatever the
 * MIME. Prompt builders take `string`, never `ContentPart[]`; bytes never reach
 * a prompt.
 */
export function altOf(parts: { alt: string }[]): string {
  return parts.map((part) => part.alt).join("\n\n");
}
