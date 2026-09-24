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
 * Handle one `cases.request.generate` message. `slot` is a generation slot
 * the caller already reserved; it is handed to the service, which releases
 * it — and released here too on every path that never reaches the service
 * (releasing twice is a no-op).
 *
 * **Ack only once the call's output is published (#159).** The generator
 * keeps nothing between calls, so an unacked request *is* the recovery
 * path: a replica that dies mid-call stops heartbeating (`msg.working()`),
 * the short ack wait runs out, and JetStream hands the request to another
 * replica. A plan-mode continuation carries its plan, so only the second
 * half reruns; anything else reruns from the start. Past
 * {@link REQUEST_MAX_ATTEMPTS} deliveries the request is failed instead.
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

    // On NATS the jobId is required: it is the address of the job's result
    // (`cases.result.<jobId>`), so a server-minted one could never be found
    // by the client that asked. Without a usable one there is nowhere to
    // send an error either, so the message is terminated, not retried.
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

    // The consumer's one extra delivery: every attempt before it crashed.
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
        // A normal-mode plan on the way: best effort, the case follows.
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
      // The job with this id is running or finished here already, and
      // publishes (or published) its own result. Answering this duplicate
      // with an error would overwrite that result for the client.
      console.warn(`[NATS] Ignoring duplicate request for jobId=${jobId}`);
    } else {
      await publishStop(graph, result);
    }
    msg.ack();
  } catch (error) {
    // Protocol-level failures only (the publish itself failing): retry.
    // Domain failures are results, published above.
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
 * Pull requests one at a time, and only once a generation slot is free.
 * Messages this replica cannot start yet stay in the stream for another
 * replica, rather than being pulled and then queued in memory. Returns when
 * the connection closes.
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
    // Not awaited: the slot, not this loop, is what bounds concurrency.
    void consumeCaseGenerateMessage(msg, graph, service, slot);
  }
}
