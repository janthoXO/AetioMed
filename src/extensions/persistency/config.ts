import { z } from "zod";

const PersistencyEnvSchema = z
  .object({
    REDIS_URL: z.url(),
  })
  .transform((env) => {
    return {
      url: env.REDIS_URL,
    };
  });

export let persistencyConfig: z.output<typeof PersistencyEnvSchema>;

export function loadConfig() {
  const parsed = PersistencyEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`❌ Invalid REDIS environment variables`);
  }

  persistencyConfig = parsed.data;
}
