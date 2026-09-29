import z from "zod";
import { ContentPartsSchema, type ContentPart } from "./ContentPart.js";

/** Domain shape: one or more content parts. See `ContentPart.ts`. */
export const ChiefComplaintSchema = ContentPartsSchema.describe(
  "The chief complaint of the patient, as one or more content parts"
);

export type ChiefComplaint = ContentPart[];

/** LLM-facing shape: plain `z.string()`, never bytes. Gateway wraps it into a `ContentPart`. */
const ChiefComplaintTextSchema = z
  .string()
  .describe("The chief complaint of the patient");

export const ChiefComplaintJsonSchema = z.object({
  chiefComplaint: ChiefComplaintTextSchema,
});
