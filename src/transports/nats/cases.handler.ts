import type { Consumer, JsMsg } from "@nats-io/jetstream";
import { makeCaseGenerationRequestSchema, JobIdSchema } from "@/api/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { CaseGenerationService } from "@/core/caseGenerationService.js";
import type { Release } from "@/core/concurrency.js";
import {
  publishCaseResult,
  publishPlan,
  publishStop,
} from "./cases.publisher.js";
import {
  REQUEST_MAX_ATTEMPTS,
  REQUEST_SUBJECT,
  WORKING_INTERVAL_MS,
} from "./subjects.js";

const DUPLICATE_CODES = new Set([
  "JOB_ALREADY_ACTIVE",
  "JOB_ALREADY_COMPLETED",
]);

/**
 * Handle one `cases.request.generate` message. `slot` = pre-reserved
 * generation slot, handed to service; also released here on paths never
 * reaching service (double release is no-op).
 *
 * Ack only after output published. Unacked request is the recovery path:
 * dead replica stops `msg.working()`, ack wait expires, JetStream
 * redelivers. Past {@link REQUEST_MAX_ATTEMPTS} deliveries, request fails.
 */
export async function consumeCaseGenerateMessage(
  msg: JsMsg,
  graph: GraphAppContext,
  service: CaseGenerationService,
  slot?: Release
): Promise<void> {
  const working = setInterval(() => msg.working(), WORKING_INTERVAL_MS);
  working.unref?.();

  try {
    const raw = safeJson(msg);

    // jobId required: it addresses the result (`cases.result.<jobId>`).
    // Without one nowhere to send an error, so terminate, don't retry.
    const jobIdResult = JobIdSchema.safeParse(
      (raw as { jobId?: unknown } | undefined)?.jobId
    );
    if (!jobIdResult.success) {
      console.error(
        `[NATS] Dropping ${REQUEST_SUBJECT} message without a valid jobId:`,
        jobIdResult.error.issues[0]?.message
      );
      msg.term();
      return;
    }
    const jobId = jobIdResult.data;

    // Consumer's one extra delivery: all earlier attempts crashed.
    if (msg.info.deliveryCount > REQUEST_MAX_ATTEMPTS) {
      console.error(
        `[NATS] Giving up on jobId=${jobId} after ${REQUEST_MAX_ATTEMPTS} attempts`
      );
      await publishCaseResult(jobId, {
        error: {
          code: "RETRIES_EXHAUSTED",
          message: `Generation did not finish in ${REQUEST_MAX_ATTEMPTS} attempts`,
        },
      });
      msg.ack();
      return;
    }

    const request = makeCaseGenerationRequestSchema(graph.config).safeParse(
      raw
    );
    if (!request.success) {
      await publishCaseResult(jobId, {
        error: {
          code: "INVALID_REQUEST_BODY",
          message: "Invalid request body",
          details: JSON.stringify(request.error.issues),
        },
      });
      msg.ack();
      return;
    }

    console.log(`[NATS] Generating case (jobId=${jobId})`);
    const result = await service.generate(
      { ...request.data, jobId },
      {
        ...(slot && { slot }),
        // Normal-mode plan: best effort, case follows.
        onPlan: (plan) => {
          publishPlan(plan).catch((error) => {
            console.error(
              `[NATS] Failed to publish the plan for jobId=${jobId}:`,
              error
            );
          });
        },
      }
    );

    if (result.status === "failed" && DUPLICATE_CODES.has(result.error!.code)) {
      // Original job publishes its own result; an error here would overwrite it.
      console.warn(`[NATS] Ignoring duplicate request for jobId=${jobId}`);
    } else {
      await publishStop(graph, result);
    }
    msg.ack();
  } catch (error) {
    // Protocol failures only (publish failing): retry. Domain failures are results.
    console.error("[NATS] Error processing message:", error);
    msg.nak();
  } finally {
    clearInterval(working);
    slot?.();
  }
}

function safeJson(msg: JsMsg): unknown {
  try {
    return msg.json();
  } catch {
    return undefined;
  }
}

/**
 * Pull one request at a time, only once a generation slot is free; excess
 * stays in stream for other replicas. Returns when connection closes.
 */
export async function runRequestWorker(opts: {
  consumer: Consumer;
  graph: GraphAppContext;
  service: CaseGenerationService;
  isClosed: () => boolean;
}): Promise<void> {
  const { consumer, graph, service, isClosed } = opts;
  console.log(`[NATS] Consuming ${REQUEST_SUBJECT}`);

  while (!isClosed()) {
    const slot = await service.reserveSlot();
    let msg: JsMsg | null;
    try {
      msg = await consumer.next({ expires: 30_000 });
    } catch (error) {
      slot();
      if (isClosed()) return;
      console.error("[NATS] Failed to pull a request:", error);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    if (!msg) {
      slot();
      continue;
    }
    // Not awaited: slot bounds concurrency.
    void consumeCaseGenerateMessage(msg, graph, service, slot);
  }
}
