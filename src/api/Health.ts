import { z } from "zod";

/** `GET /api/health` liveness probe. */
export const HealthSchema = z.object({
  status: z.literal("ok"),
  timestamp: z.string(),
});
