import type { z } from "zod";

/**
 * An adapter's env, all or nothing: none of its variables set = `undefined`
 * (adapter off); any set = every required one must be, else parse throws at
 * startup. `""` counts as unset: `docker-compose.prod.yml` passes every
 * variable, empty when absent.
 */
export function envGroup<T extends z.ZodObject>(
  schema: T,
  env: NodeJS.ProcessEnv
): z.infer<T> | undefined {
  const values = Object.fromEntries(
    Object.keys(schema.shape).map((k) => [k, env[k] || undefined])
  );
  return Object.values(values).some((v) => v !== undefined)
    ? schema.parse(values)
    : undefined;
}
