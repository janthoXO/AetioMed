import { z } from "zod";
import { DEFAULT_REVIEW_TTL_MS } from "@/core/caseGenerationService.js";

// is only loaded when NATS feature is enabled
export const ConfigSchema = z
  .object({
    NATS_URL: z.url().default("nats://localhost:4222"),
    NATS_USER: z.string().default("nats"),
    NATS_PASSWORD: z.string().default("nats"),
    // Plan mode (#159): `CASE_REVIEWS`'s `max_age` — read the same way
    // `app.ts` reads it for the service itself, so a paused job's review
    // outlives on the wire exactly as long as the service is willing to
    // wait for a decision on it.
    REVIEW_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(DEFAULT_REVIEW_TTL_MS / 60_000),
  })
  .transform((env) => {
    return {
      url: env.NATS_URL,
      user: env.NATS_USER,
      password: env.NATS_PASSWORD,
      reviewTtlMs: env.REVIEW_TTL_MINUTES * 60_000,
    };
  });

export type Config = z.output<typeof ConfigSchema>;
