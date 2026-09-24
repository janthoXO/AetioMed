import { z } from "zod";
import { EventBus } from "./event-bus.js";
import { ConfigSchema as GraphConfigSchema, initGraph } from "./graph/index.js";
import {
  resolveCatalogDir,
  resolveCacheDir,
} from "./graph/persistence/paths.js";
import {
  createCaseGenerationService,
  DEFAULT_MAX_CONCURRENT_GENERATIONS,
} from "./caseGenerationService.js";
import {
  createJobEventChannel,
  createLocalJobDirectory,
  wireLabels,
  type JobDirectory,
} from "./jobEvents/index.js";
import { createReadModel } from "./readModel.js";
import { startRestServer } from "../transports/rest/index.js";
import { startNatsTransport } from "../transports/nats/index.js";
import { createOtelNodeTracer } from "../observability/otel.js";
import { runClosers, type Closer } from "../shutdown.js";

const AppEnvSchema = z
  .object({
    FEATURES: z.string().default(""),
    SYMPTOM_CACHE_TTL_DAYS: z.coerce.number().default(30),
    // One limit for every transport. Excess jobs queue.
    MAX_CONCURRENT_GENERATIONS: z.coerce
      .number()
      .int()
      .min(1)
      .default(DEFAULT_MAX_CONCURRENT_GENERATIONS),
  })
  .transform((env) => ({
    features: env.FEATURES.split(",")
      .map((f) => f.trim())
      .filter(Boolean),
    symptomCacheTtlDays: env.SYMPTOM_CACHE_TTL_DAYS,
    maxConcurrentGenerations: env.MAX_CONCURRENT_GENERATIONS,
  }));

/**
 * Composition root: constructs everything explicitly, in order. `FEATURES`
 * flags (`REST`, `NATS`, `DEBUG`, `ALLOW_LLMS`) each gate one construction.
 *
 * `shutdown()` closes everything started, in reverse construction order:
 * REST, NATS, DB last. Registers no signal handler; `src/index.ts` does via
 * `installSignalHandlers`. Unstarted feature contributes no closer.
 */
export async function createApp(): Promise<{
  bus: EventBus;
  shutdown: () => Promise<void>;
}> {
  const {
    features: featureList,
    symptomCacheTtlDays,
    maxConcurrentGenerations,
  } = AppEnvSchema.parse(process.env);
  const features = new Set(featureList);
  console.log(`[app] Feature flags: ${[...features].join(", ") || "none"}`);
  const graphConfig = GraphConfigSchema.parse(process.env);
  const bus = new EventBus();
  // Operator channel, gated by standard OTel env vars, not `FEATURES`.
  // `DEBUG` only picks the console exporter when no OTLP endpoint set.
  const otel = await createOtelNodeTracer({ debug: features.has("DEBUG") });
  const graph = initGraph({
    bus,
    config: graphConfig,
    catalogDir: resolveCatalogDir(process.env),
    cacheDir: resolveCacheDir(process.env),
    symptomCacheTtlDays,
    tracer: otel.tracer,
  });

  // Per-job event channel: service opens/closes jobs, transports subscribe.
  // Labels always on.
  const jobEvents = createJobEventChannel();
  wireLabels(bus, jobEvents, graph.runtime.catalogs.labels);

  const service = createCaseGenerationService(graph, bus, jobEvents, {
    maxConcurrent: maxConcurrentGenerations,
  });

  // Shared read model: REST and NATS read-only endpoints answer via same functions.
  const readModel = createReadModel(graph, features);

  // NATS starts first: REST may ride on it. REST still closes first.
  const nats = features.has("NATS")
    ? await startNatsTransport({
        graph,
        service,
        jobEvents,
        readModel,
      })
    : undefined;

  const rest = features.has("REST")
    ? await startRestServer({
        graph,
        service,
        jobEvents,
        directory: selectJobDirectory({
          features,
          local: createLocalJobDirectory(jobEvents, service.cancel),
          nats: nats?.directory,
        }),
        readModel,
        features,
      })
    : undefined;

  const closers: Closer[] = [];
  if (rest) closers.push({ name: "REST", close: rest.close });
  if (nats) closers.push({ name: "NATS", close: nats.close });

  // OTel after NATS, before DB: flush batched spans/logs once producers stopped.
  closers.push({ name: "OTel", close: otel.shutdown });

  // DB last, always: all writers already stopped.
  closers.push({ name: "DB", close: async () => graph.db.close() });

  const shutdown = () => runClosers(closers);

  return { bus, shutdown };
}

/**
 * With `REST` and `NATS` both enabled, REST watches/cancels jobs over NATS
 * (sees every replica). Otherwise in-process channel: single replica only.
 * REST depends on NATS via composition only, never the reverse.
 */
export function selectJobDirectory(opts: {
  features: ReadonlySet<string>;
  local: JobDirectory;
  nats: JobDirectory | undefined;
}): JobDirectory {
  if (!opts.features.has("NATS")) return opts.local;
  if (opts.nats) return opts.nats;
  console.warn(
    "[app] NATS is enabled but not connected: REST falls back to in-process job lookups, which only see this replica's jobs."
  );
  return opts.local;
}
