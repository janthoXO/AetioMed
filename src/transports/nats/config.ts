import { z } from "zod";

// is only loaded when NATS feature is enabled
export const ConfigSchema = z
  .object({
    NATS_URL: z.url().default("nats://localhost:4222"),
    NATS_USER: z.string().default("nats"),
    NATS_PASSWORD: z.string().default("nats"),
  })
  .transform((env) => {
    return {
      url: env.NATS_URL,
      user: env.NATS_USER,
      password: env.NATS_PASSWORD,
    };
  });

export type Config = z.output<typeof ConfigSchema>;
