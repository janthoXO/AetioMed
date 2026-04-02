import z from "zod";

export const LanguageSchema = z.enum(["English", "German"]);

export type Language = z.infer<typeof LanguageSchema>;

export const ForeignLanguageSchema = LanguageSchema.exclude(["English"]);
export type ForeignLanguage = z.infer<typeof ForeignLanguageSchema>;
