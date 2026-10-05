// Shared request/response Zod schemas for both transports (rest, nats).

export {
  makeCaseGenerationRequestSchema,
  type CaseGenerationRequest,
} from "./CaseGenerationRequest.js";

export { CaseGenerationResponseSchema } from "./CaseGenerationResponse.js";

export { JobIdSchema } from "./JobId.js";
