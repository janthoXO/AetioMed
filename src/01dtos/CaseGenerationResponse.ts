import { z } from "zod";
import { CaseSchema } from "@/02domain-models/Case.js";
import { ErrorResponseSchema } from "./ErrorResponse.js";

export const CaseGenerationResponseSchema = z.union([
  CaseSchema,
  ErrorResponseSchema,
]);

export type CaseGenerationResponse = z.infer<
  typeof CaseGenerationResponseSchema
>;
