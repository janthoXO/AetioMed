// Shared request/response Zod schemas for case generation, consumed by both
// transports (rest, nats).

export {
  makeCaseGenerationRequestSchema,
  type CaseGenerationRequest,
} from "./CaseGenerationRequest.js";

export { CaseGenerationResponseSchema } from "./CaseGenerationResponse.js";

export { JobIdSchema } from "./JobId.js";

export {
  ReviewDecisionRequestSchema,
  type ReviewDecisionRequest,
  type ReviewDecision,
} from "./ReviewDecision.js";
