import z from "zod";

export const GenerationFlagSchema = z.enum(["chiefComplaint", "anamnesis"]);

export type GenerationFlag = z.infer<typeof GenerationFlagSchema>;

export const AllGenerationFlags: GenerationFlag[] =
  GenerationFlagSchema.options;
