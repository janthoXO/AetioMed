import z from "zod";

export const GenerationFlagsSchema = z.enum(["chiefComplaint", "anamnesis"]);

export type GenerationFlags = z.infer<typeof GenerationFlagsSchema>;

export const AllGenerationFlags: GenerationFlags[] =
  GenerationFlagsSchema.options;
