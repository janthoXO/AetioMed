import { z } from "zod";
import { CaseWireSchema } from "./contentWire.js";
import { ErrorResponseSchema } from "./ErrorResponse.js";

// The wire shape (`CaseWireSchema`), not the domain `CaseSchema`: the
// response body carries `ContentPart[]` fields encoded per issue 11 §5 —
// `value` as a JSON string (UTF-8 for text/*, base64 otherwise) — not raw
// `Uint8Array`, which would otherwise JSON-stringify to `{"0":102,…}`.
export const CaseGenerationResponseSchema = z.union([
  CaseWireSchema.extend({
    jobId: z.string().optional(),
  }),
  ErrorResponseSchema,
]);

export type CaseGenerationResponse = z.infer<
  typeof CaseGenerationResponseSchema
>;
