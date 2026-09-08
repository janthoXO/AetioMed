import z from "zod";
import { ContentPartsSchema, type ContentPart } from "./ContentPart.js";

/**
 * Domain shape: the chief complaint rendered as one or more content parts
 * (issue 11). See `ContentPart.ts` for additive-parts semantics.
 */
export const ChiefComplaintSchema = ContentPartsSchema.describe(
  "The chief complaint of the patient, as one or more content parts"
);

export type ChiefComplaint = ContentPart[];

/**
 * LLM-facing shape: the generator produces ordinary text under a plain
 * `z.string()` schema — the LLM is never asked to emit bytes or base64
 * (issue 11 §3). The gateway wraps the result with `textPart()` to build
 * the domain `ChiefComplaint` above.
 */
const ChiefComplaintTextSchema = z
  .string()
  .describe("The chief complaint of the patient");

export const ChiefComplaintJsonSchema = z.object({
  chiefComplaint: ChiefComplaintTextSchema,
});
