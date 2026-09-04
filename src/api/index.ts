// Plain schema module — not an extension. Shared request/response Zod
// schemas for case generation, consumed by both transports (rest, nats)
// and by the swagger doc-generation script.

export {
  makeCaseGenerationRequestSchema,
  type CaseGenerationRequest,
} from "./CaseGenerationRequest.js";

export {
  CaseGenerationResponseSchema,
  type CaseGenerationResponse,
} from "./CaseGenerationResponse.js";

export { ErrorResponseSchema, type ErrorResponse } from "./ErrorResponse.js";
