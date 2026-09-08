import { z } from "zod";
import { EventBus } from "./event-bus.js";
import { ConfigSchema as GraphConfigSchema, initGraph } from "./graph/index.js";
import {
  resolveCatalogDir,
  resolveCacheDir,
} from "./graph/persistence/paths.js";
import { createCaseGenerationService } from "./caseGenerationService.js";
import { startRestServer } from "../transports/rest/index.js";
import { startNatsTransport } from "../transports/nats/index.js";
import { wireTracing } from "../tracing/index.js";
import { createOtelNodeTracer } from "../tracing/otel.js";

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

/**
 * The composition root: everything is constructed here, explicitly and in
 * order. `FEATURES` is a comma-separated set of flags — `REST`, `NATS`,
 * `TRACING`, `DEBUG`, `ALLOW_LLMS` — each gating one construction below.
 */
export async function createApp(): Promise<{ bus: EventBus }> {
  const { features: featureList, symptomCacheTtlDays } = AppEnvSchema.parse(
    process.env
  );
  const features = new Set(featureList);
  console.log(`[app] Feature flags: ${[...features].join(", ") || "none"}`);
  const graphConfig = GraphConfigSchema.parse(process.env);
  const bus = new EventBus();
  // Issue 15 §1.1/§5 — the OTel channel is independent of `FEATURES`:
  // always constructed here, gated only by the standard
  // `OTEL_SDK_DISABLED`, never by `TRACING` (that flag stays scoped to the
  // EventBus/SSE label+trace channel below). See `tracing/index.ts`'s
  // `wireTracing` doc comment for why the two are deliberately separate.
  const tracer = await createOtelNodeTracer();
  const graph = initGraph({
    bus,
    config: graphConfig,
    catalogDir: resolveCatalogDir(process.env),
    cacheDir: resolveCacheDir(process.env),
    symptomCacheTtlDays,
    tracer,
  });

  const service = createCaseGenerationService(graph, bus);

  if (features.has("TRACING")) {
    wireTracing(
      bus,
      graph.runtime.catalogs.labels,
      graph.config.MAX_CONTENT_PART_BYTES
    );
  }

  if (features.has("REST")) {
    await startRestServer({ graph, service, features });
  }

  if (features.has("NATS")) {
    await startNatsTransport({ graph, service });
  }

  return { bus };
}
