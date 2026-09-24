import z from "zod";

/** `values`: index-keyed record of text segments. Graph never knows what a segment is; it translates a keyed string record (shape `translateRecordKeyed` in `03aigateway/translate.helper.ts` expects). */
export const OutlineTranslationStateSchema = z.object({
  values: z.record(z.string(), z.string()),
  translations: z.record(z.string(), z.string()).default({}),
});

export type OutlineTranslationState = z.infer<
  typeof OutlineTranslationStateSchema
>;
