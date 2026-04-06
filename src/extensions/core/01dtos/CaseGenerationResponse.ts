import { z } from "zod";
import { CaseSchema } from "@/extensions/core/models/Case.js";
import { ErrorResponseSchema } from "./ErrorResponse.js";

export const CaseGenerationResponseSchema = z.union([
  CaseSchema.extend({
    traceId: z.string().optional(),
  }),
  ErrorResponseSchema,
]);

export type CaseGenerationResponse = z.infer<
  typeof CaseGenerationResponseSchema
>;
