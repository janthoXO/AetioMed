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
    // One limit for every transport (#142), so throughput does not depend
    // on which door a request came in through. Excess jobs queue.
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
  const {
    features: featureList,
    symptomCacheTtlDays,
    maxConcurrentGenerations,
  } = AppEnvSchema.parse(process.env);
  const features = new Set(featureList);
  console.log(`[app] Feature flags: ${[...features].join(", ") || "none"}`);
  const graphConfig = GraphConfigSchema.parse(process.env);
  const bus = new EventBus();
  // The operator's channel (issue 15, #141), gated by the standard OTel env
  // vars rather than a `FEATURES` flag. `DEBUG` only picks the
  // zero-infrastructure console exporter when no OTLP endpoint is set.
  // Labels (below) are the end user's channel.
  const otel = await createOtelNodeTracer({ debug: features.has("DEBUG") });
  const graph = initGraph({
    bus,
    config: graphConfig,
    catalogDir: resolveCatalogDir(process.env),
    cacheDir: resolveCacheDir(process.env),
    symptomCacheTtlDays,
    tracer: otel.tracer,
  });

  // The per-job event channel is core-owned (#139): the service opens and
  // closes each job on it, and every transport subscribes to it. Labels are
  // always on (#140) — a product feature of the streaming API.
  const jobEvents = createJobEventChannel();
  wireLabels(bus, jobEvents, graph.runtime.catalogs.labels);

  const service = createCaseGenerationService(graph, bus, jobEvents, {
    maxConcurrent: maxConcurrentGenerations,
  });

  // Shared read model (#144): both transports' read-only endpoints answer
  // the same question through the same function, so "NATS parity" is true
  // by construction rather than by keeping two copies in sync.
  const readModel = createReadModel(graph, features);

  // NATS starts first when enabled, because REST may ride on it (#145) —
  // but REST still closes first: stop accepting work before the backbone
  // goes away.
  const nats = features.has("NATS")
    ? await startNatsTransport({ graph, service, jobEvents, readModel })
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

  // OTel after NATS, before the DB: flush batched spans/logs once producers
  // have stopped emitting them, but before the process (and its DB) exits.
  closers.push({ name: "OTel", close: otel.shutdown });

  // DB last, unconditionally: it always exists (unlike REST/NATS, which are
  // feature-gated), and everything that might still write to it — REST
  // handlers, the NATS consumer — has already stopped by the time this
  // runs.
  closers.push({ name: "DB", close: async () => graph.db.close() });

  const shutdown = () => runClosers(closers);

  return { bus, shutdown };
}

/**
 * The partial NATS backbone (#145, design doc §D5): with both `REST` and
 * `NATS` enabled, REST watches and cancels jobs over NATS, so it sees jobs
 * on every replica. Otherwise it uses the in-process channel, and a single
 * replica is a documented deployment constraint.
 *
 * REST depends on NATS here — through composition only — and never the
 * reverse: NATS is infrastructure in this one place, not a peer.
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
