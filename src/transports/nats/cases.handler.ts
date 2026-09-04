import { makeCaseGenerationRequestSchema } from "@/api/index.js";
import { getJetStreamClient, getNatsConnection } from "./client.js";
import { AckPolicy, jetstreamManager, type JsMsg } from "@nats-io/jetstream";
import * as cancelManager from "@/core/graph/utils/cancelManager.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { CaseGenerationService } from "@/core/caseGenerationService.js";
import { publishCaseGenerationResponse } from "./cases.publisher.js";
import { encodeCase } from "@/api/contentWire.js";
import z from "zod";

const STREAM_NAME = "cases";
const SUBJECT = "cases.generate";
const CONSUMER_NAME = "cases-generate-consumer";

const JobIdSchema = z.object({
  jobId: z.string().optional(),
});

const CancelMessageSchema = z.object({
  jobId: z.string().optional(),
});

export async function consumeCaseGenerateMessage(
  msg: JsMsg,
  graph: GraphAppContext,
  service: CaseGenerationService
) {
  const NatsCaseGenerationRequestSchema = makeCaseGenerationRequestSchema(
    graph.config
  ).and(JobIdSchema);

  // Extract jobId before try/catch so it's accessible in the error handler
  const jobIdResult = JobIdSchema.safeParse(msg.json());
  const jobId = jobIdResult.data?.jobId ?? crypto.randomUUID();

  try {
    console.debug(`[NATS] Received message on ${SUBJECT}:`, msg.json());
    const data = NatsCaseGenerationRequestSchema.parse(msg.json());

    console.log(`[NATS] Generating case (jobId=${jobId})`);
    const result = await service.generate({ ...data, jobId });

    if (result.status === "done") {
      await publishCaseGenerationResponse(
        jobId,
        encodeCase(result.case!, graph.config.MAX_CONTENT_PART_BYTES) as Record<
          string,
          unknown
        >
      );
    } else {
      await publishCaseGenerationResponse(jobId, {
        error: {
          code: result.error!.code,
          message: result.error!.message,
          details: result.error!.details,
        },
      });
    }
    msg.ack();
  } catch (err) {
    // Protocol-level failures only: bad message payload, or the publish
    // itself failing. Domain failures (generation error, cancellation,
    // unresolvable ICD) are already handled above via the service's result.
    console.error(`[NATS] Error processing message:`, err);

    try {
      await publishCaseGenerationResponse(jobId, {
        error: {
          code: "GENERATION_FAILED",
          message: "An unexpected error occurred",
          details: err instanceof Error ? err.message : String(err),
        },
      });
      msg.ack(); // Ack even on error because we processed it by sending an error response
    } catch (pubErr) {
      console.error("[NATS] Failed to publish error response:", pubErr);
      msg.nak(); // Retry if we couldn't publish the error
    }
  }
}

function startCancelSubscription() {
  const nc = getNatsConnection();
  const sub = nc.subscribe("cases.cancel.>");

  (async () => {
    for await (const msg of sub) {
      try {
        const result = CancelMessageSchema.safeParse(msg.json());
        const jobId = result.data?.jobId ?? msg.subject.split(".").pop()!;
        const aborted = cancelManager.abort(jobId);
        console.log(
          `[NATS] Cancel request for jobId=${jobId}: ${aborted ? "aborted" : "not found"}`
        );
      } catch (err) {
        console.error("[NATS] Error processing cancel message:", err);
      }
    }
  })();
}

export async function startCaseGenerationConsumer(
  graph: GraphAppContext,
  service: CaseGenerationService
) {
  const nc = getNatsConnection();
  const js = getJetStreamClient();
  const jsm = await jetstreamManager(nc);

  const streamInf = await jsm.streams.info(STREAM_NAME).catch(() => null);
  if (!streamInf) {
    console.log(`[NATS] Creating stream ${STREAM_NAME}...`);
    await jsm.streams.add({
      name: STREAM_NAME,
      subjects: [`${STREAM_NAME}.>`],
      retention: "workqueue",
      storage: "file",
      duplicate_window: 2 * 60 * 1000 * 1000 * 1000, // 2 minutes in nanoseconds
    });
  }

  const consumerInf = await jsm.consumers
    .info(STREAM_NAME, CONSUMER_NAME)
    .catch(() => null);
  if (!consumerInf) {
    console.log(`[NATS] Creating consumer ${CONSUMER_NAME}...`);
    await jsm.consumers.add(STREAM_NAME, {
      filter_subject: SUBJECT,
      durable_name: CONSUMER_NAME,
      ack_policy: AckPolicy.Explicit,
      ack_wait: 10 * 60 * 1000 * 1000 * 1000, // 10 minutes
    });
  }

  startCancelSubscription();

  console.log(`[NATS] subscribing to ${SUBJECT}`);
  const consumer = await js.consumers.get(STREAM_NAME, CONSUMER_NAME);
  const messages = await consumer.consume({ max_messages: 1 });
  for await (const msg of messages) {
    // Awaited deliberately: without this, ack/nak races the next loop
    // iteration and generations pile up unbounded despite max_messages: 1.
    await consumeCaseGenerateMessage(msg, graph, service);
  }
}
