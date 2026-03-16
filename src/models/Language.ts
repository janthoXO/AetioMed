import z from "zod";

export const LanguageSchema = z.enum(["English", "German"]);

export type Language = z.infer<typeof LanguageSchema>;
