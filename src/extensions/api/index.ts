import { defineExtension } from "../../core/extension.js";
import z from "zod";

export {
  CaseGenerationRequestSchema,
  type CaseGenerationRequest,
} from "./CaseGenerationRequest.js";

export {
  CaseGenerationResponseSchema,
  type CaseGenerationResponse,
} from "./CaseGenerationResponse.js";

export { ErrorResponseSchema, type ErrorResponse } from "./ErrorResponse.js";

// No runtime state — schemas are evaluated at module load time.
export const extension = defineExtension({
  name: "api",
  requiredFlags: [],
  envSchema: z.object({}),
  async setup() {},
});
