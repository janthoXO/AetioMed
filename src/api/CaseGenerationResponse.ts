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
    // The language generation actually resolved to (issue 10 §5) — not
    // necessarily the `language` the caller requested, since it may have
    // been omitted and auto-detected. Echoed so a client can notice a wrong
    // guess and retry with an explicit `language`.
    language: z.string(),
  }),
  ErrorResponseSchema,
]);

export type CaseGenerationResponse = z.infer<
  typeof CaseGenerationResponseSchema
>;
