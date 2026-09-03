import { z } from "zod";
import { EventBus } from "./event-bus.js";
import { loadExtensions } from "./loader.js";
import type { AnyExt } from "./extension.js";
import { ConfigSchema as GraphConfigSchema, initGraph } from "./graph/index.js";

const AppEnvSchema = z
  .object({ FEATURES: z.string().default("") })
  .transform((env) => ({
    features: env.FEATURES.split(",")
      .map((f) => f.trim())
      .filter(Boolean),
  }));

export async function createApp(
  extensions: readonly AnyExt[]
): Promise<{ bus: EventBus }> {
  const { features } = AppEnvSchema.parse(process.env);
  console.log(`[app] Feature flags: ${features.join(", ") || "none"}`);

  const graphConfig = GraphConfigSchema.parse(process.env);
  const eventBus = new EventBus();
  initGraph({ bus: eventBus, config: graphConfig });

  await loadExtensions({
    extensions: [...extensions],
    enabledFlags: new Set(features),
    bus: eventBus,
  });

  return { bus: eventBus };
}
