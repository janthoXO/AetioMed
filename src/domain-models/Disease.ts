import z from "zod";
import { ICDCodeSchema } from "./ICD.js";

export const DiseaseSchema = z.object({
  code: ICDCodeSchema.describe("ICD-10 code of the disease"),
  name: z.string().describe("Name of the disease"),
});

export type Disease = z.infer<typeof DiseaseSchema>;
