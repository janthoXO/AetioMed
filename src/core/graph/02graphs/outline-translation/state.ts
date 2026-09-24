import z from "zod";

/**
 * `values` is an index-keyed record of text segments — the plan-mode
 * outline's segments, not the outline itself (issue #159). This graph never
 * knows what a segment *is* (a heading, a paragraph); it only translates a
 * keyed record of strings, the same shape `translateRecordKeyed`
 * (`03aigateway/translate.helper.ts`) already expects.
 */
export const OutlineTranslationStateSchema = z.object({
  values: z.record(z.string(), z.string()),
  translations: z.record(z.string(), z.string()).default({}),
});

export type OutlineTranslationState = z.infer<
  typeof OutlineTranslationStateSchema
>;
