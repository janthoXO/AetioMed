import { z } from "zod";
import { CaseWireSchema } from "./contentWire.js";
import { ErrorResponseSchema } from "./ErrorResponse.js";

// Wire shape (`CaseWireSchema`), not domain `CaseSchema`: `ContentPart[]` value
// is JSON string (UTF-8 for text/*, base64 otherwise), not raw `Uint8Array`.
export const CaseGenerationResponseSchema = z.union([
  CaseWireSchema.extend({
    jobId: z.string().optional(),
    // Language generation resolved to; may differ from requested (auto-detect).
    // Echoed so client can retry with explicit `language`.
    language: z.string(),
  }),
  ErrorResponseSchema,
]);

export type CaseGenerationResponse = z.infer<
  typeof CaseGenerationResponseSchema
>;
