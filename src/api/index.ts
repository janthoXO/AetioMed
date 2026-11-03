// Shared request/response Zod schemas for both transports (rest, nats).

export {
  makeCaseGenerationRequestSchema,
  type CaseGenerationRequest,
} from "./CaseGenerationRequest.js";

export { CaseGenerationResponseSchema } from "./CaseGenerationResponse.js";

export { JobIdSchema } from "./JobId.js";

export { ErrorResponseSchema } from "./ErrorResponse.js";

export {
  CancelReplySchema,
  JobStatusReplySchema,
  type JobStatusReply,
} from "./JobReplies.js";

export { HealthSchema } from "./Health.js";
