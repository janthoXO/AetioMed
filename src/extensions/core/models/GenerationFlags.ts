import z from "zod";

export const GenerationFlagSchema = z.enum([
  "patient",
  "chiefComplaint",
  "anamnesis",
  "procedures",
]);

export type GenerationFlag = z.infer<typeof GenerationFlagSchema>;

export const AllGenerationFlags: GenerationFlag[] =
  GenerationFlagSchema.options;
