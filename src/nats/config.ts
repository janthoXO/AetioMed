import { z } from "zod";

// is only loaded when NATS feature is enabled
const NatsEnvSchema = z
  .object({
    NATS_URL: z.url(),
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

export let natsConfig: z.output<typeof NatsEnvSchema>;

export function loadConfig() {
  const parsed = NatsEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`❌ Invalid NATS environment variables`);
  }

  natsConfig = parsed.data;
}
