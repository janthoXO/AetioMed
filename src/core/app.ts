import { z } from "zod";
import { EventBus } from "./event-bus.js";
import { ConfigSchema as GraphConfigSchema, initGraph } from "./graph/index.js";
import {
  resolveCatalogDir,
  resolveCacheDir,
} from "./graph/persistence/paths.js";
import { createCaseGenerationService } from "./caseGenerationService.js";
import { createJobEventChannel, wireLabels } from "./jobEvents/index.js";
import { startRestServer } from "../transports/rest/index.js";
import { startNatsTransport } from "../transports/nats/index.js";
import { createOtelNodeTracer } from "../observability/otel.js";
import { runClosers, type Closer } from "../shutdown.js";

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
 * `DEBUG`, `ALLOW_LLMS` — each gating one construction below.
 *
 * It also owns shutdown (issue 18): `shutdown()` closes everything this
 * function started, in the **reverse** of construction order — REST first
 * (stop accepting new work), then NATS, then the DB last (everything that
 * might still write has stopped by then). It does not register any signal
 * handler itself — `src/index.ts` does that via `installSignalHandlers`
 * (`src/shutdown.ts`), which keeps `createApp` free of process-global side
 * effects and the sequence testable without spawning a process. A feature
 * that never started contributes no closer, so nothing here branches on
 * `features.has(...)` a second time.
 */
export async function createApp(): Promise<{
  bus: EventBus;
  shutdown: () => Promise<void>;
}> {
  const { features: featureList, symptomCacheTtlDays } = AppEnvSchema.parse(
    process.env
  );
  const features = new Set(featureList);
  console.log(`[app] Feature flags: ${[...features].join(", ") || "none"}`);
  const graphConfig = GraphConfigSchema.parse(process.env);
  const bus = new EventBus();
  // Issue 15 §1.1/§5 — the OTel channel is independent of `FEATURES`:
  // always constructed here, gated only by the standard OTel env vars. It is
  // the operator's channel; labels (below) are the end user's.
  const tracer = await createOtelNodeTracer();
  const graph = initGraph({
    bus,
    config: graphConfig,
    catalogDir: resolveCatalogDir(process.env),
    cacheDir: resolveCacheDir(process.env),
    symptomCacheTtlDays,
    tracer,
  });

  // The per-job event channel is core-owned (#139): the service opens and
  // closes each job on it, and every transport subscribes to it. Labels are
  // always on (#140) — a product feature of the streaming API.
  const jobEvents = createJobEventChannel();
  wireLabels(bus, jobEvents, graph.runtime.catalogs.labels);

  const service = createCaseGenerationService(graph, bus, jobEvents);

  const closers: Closer[] = [];

  if (features.has("REST")) {
    const rest = await startRestServer({ graph, service, jobEvents, features });
    closers.push({ name: "REST", close: rest.close });
  }

  if (features.has("NATS")) {
    const nats = await startNatsTransport({ graph, service });
    closers.push({ name: "NATS", close: nats.close });
  }

  // DB last, unconditionally: it always exists (unlike REST/NATS, which are
  // feature-gated), and everything that might still write to it — REST
  // handlers, the NATS consumer — has already stopped by the time this
  // runs.
  closers.push({ name: "DB", close: async () => graph.db.close() });

  const shutdown = () => runClosers(closers);

  return { bus, shutdown };
}
