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
  // NATS `cases.result.<jobId>` failures carry the jobId; REST errors don't.
  ErrorResponseSchema.extend({ jobId: z.string().optional() }),
]);

export type CaseGenerationResponse = z.infer<
  typeof CaseGenerationResponseSchema
>;
