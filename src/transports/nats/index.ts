import { jetstreamManager } from "@nats-io/jetstream";
import {
  connectNats,
  closeNats,
  getJetStreamClient,
  getNatsConnection,
} from "./client.js";
import { runRequestWorker } from "./cases.handler.js";
import { startJobResponders } from "./jobResponders.js";
import { startProgressPublisher } from "./progressPublisher.js";
import { startMetaService } from "./metaService.js";
import { ensureStreams } from "./streams.js";
import { createNatsJobDirectory } from "./jobDirectory.js";
import { publishStop } from "./cases.publisher.js";
import { REQUESTS_STREAM, REQUEST_CONSUMER } from "./subjects.js";
import { ConfigSchema } from "./config.js";
import type { GraphAppContext } from "../../core/graph/appContext.js";
import type { CaseGenerationService } from "../../core/caseGenerationService.js";
import type {
  JobDirectory,
  JobEventChannel,
} from "../../core/jobEvents/index.js";
import type { ReadModel } from "../../core/readModel.js";

export interface NatsTransportHandle {
  close(): Promise<void>;
  /**
   * Finds jobs across every replica (#145) — set only once the connection
   * and the streams are up. REST uses it for its label stream and `DELETE`
   * when both transports are enabled.
   */
  directory?: JobDirectory;
}

/**
 * Start the NATS transport: connect, reconcile the JetStream streams, answer
 * per-job cancel requests, and consume `cases.request.generate`.
 * Constructed explicitly by the composition root (`app.ts`) when the `NATS`
 * flag is set — no loader.
 *
 * Returns a closer rather than registering its own signal handlers (issue
 * 18): shutdown is one sequence owned by the composition root
 * (`src/shutdown.ts`), not scattered per-transport, which is what let a
 * transport's shutdown race a persistence module's and lose.
 */
export async function startNatsTransport(opts: {
  graph: GraphAppContext;
  service: CaseGenerationService;
  jobEvents: JobEventChannel;
  readModel: ReadModel;
}): Promise<NatsTransportHandle> {
  const { graph, service, jobEvents, readModel } = opts;
  const config = ConfigSchema.parse(process.env);
  let stopResponders: (() => void) | undefined;
  let stopProgressPublisher: (() => void) | undefined;
  let stopMetaService: (() => Promise<void>) | undefined;
  let stopDetachedOutcomes: (() => void) | undefined;
  let directory: JobDirectory | undefined;

  const close = async () => {
    stopResponders?.();
    stopProgressPublisher?.();
    stopDetachedOutcomes?.();
    await stopMetaService?.();
    await closeNats();
  };

  console.log("[NATS] Initializing NATS transport...");
  try {
    await connectNats(config);
    const nc = getNatsConnection();

    await ensureStreams(await jetstreamManager(nc), config.reviewTtlMs);
    stopResponders = startJobResponders({ nc, graph, jobEvents, service });
    stopProgressPublisher = startProgressPublisher({ nc, jobEvents });
    stopMetaService = await startMetaService({ nc, readModel });
    directory = createNatsJobDirectory(nc);

    // Plan mode (#159): checkpointed NATS jobs from before a restart pick
    // up where they left off, and each one's next stop is delivered exactly
    // like a fresh segment's — through the same `publishStop`. Failures are
    // logged, never thrown: one unresumable job must not abort the whole
    // transport's startup.
    for (const { jobId, result } of service.resume("nats")) {
      result
        .then((r) => publishStop(graph, r))
        .catch((error) => {
          console.error(`[NATS] Failed to resume jobId=${jobId}:`, error);
        });
    }
    // A paused job cancelled or expired with nobody waiting on it (#159)
    // still has a client that will ask `cases.result.<jobId>`/
    // `cases.review.<jobId>` for an answer — publish it exactly as a live
    // segment's stop would be.
    stopDetachedOutcomes = service.onDetachedOutcome((result, transport) => {
      if (transport !== "nats") return;
      publishStop(graph, result).catch((error) => {
        console.error(
          `[NATS] Failed to publish detached outcome for jobId=${result.jobId}:`,
          error
        );
      });
    });

    const consumer = await getJetStreamClient().consumers.get(
      REQUESTS_STREAM.name,
      REQUEST_CONSUMER
    );
    runRequestWorker({
      consumer,
      graph,
      service,
      isClosed: () => nc.isClosed(),
    }).catch((error) => {
      console.error("[NATS] Request worker stopped:", error);
    });
  } catch (error) {
    console.error(
      "[NATS] Failed to start the NATS transport:",
      error instanceof Error ? error.message : error
    );
  }

  return { close, ...(directory && { directory }) };
}
