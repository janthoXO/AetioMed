import { z } from "zod";
import { EventBus } from "./event-bus.js";
import { loadExtensions } from "./loader.js";
import type { AnyExt } from "./extension.js";
import { ConfigSchema as GraphConfigSchema, initGraph } from "./graph/index.js";
import {
  resolveCatalogDir,
  resolveCacheDir,
} from "./graph/persistence/paths.js";

const AppEnvSchema = z
  .object({
    FEATURES: z.string().default(""),
    SYMPTOM_CACHE_TTL_DAYS: z.coerce.number().default(30),
  })
  .transform((env) => ({
    features: env.FEATURES.split(",")
      .map((f) => f.trim())
      .filter(Boolean),
    symptomCacheTtlDays: env.SYMPTOM_CACHE_TTL_DAYS,
  }));

export async function createApp(
  extensions: readonly AnyExt[]
): Promise<{ bus: EventBus }> {
  const { features, symptomCacheTtlDays } = AppEnvSchema.parse(process.env);
  console.log(`[app] Feature flags: ${features.join(", ") || "none"}`);

  const graphConfig = GraphConfigSchema.parse(process.env);
  const eventBus = new EventBus();
  const graph = initGraph({
    bus: eventBus,
    config: graphConfig,
    catalogDir: resolveCatalogDir(process.env),
    cacheDir: resolveCacheDir(process.env),
    symptomCacheTtlDays,
  });

  await loadExtensions({
    extensions: [...extensions],
    enabledFlags: new Set(features),
    bus: eventBus,
    graph,
  });

  return { bus: eventBus };
}
