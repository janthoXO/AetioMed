import { CaseGenerationRequestSchema } from "@/extensions/api/CaseGenerationRequest.js";
import { getJetStreamClient, getNatsConnection } from "./client.js";
import { AckPolicy, jetstreamManager, type JsMsg } from "@nats-io/jetstream";
import {
  generateCase,
  bus,
  runWithContext,
  cancelManager,
} from "@/core/graph/index.js";
import { publishCaseGenerationResponse } from "./cases.publisher.js";
import { IcdToDiagnosisName } from "@/core/graph/03repo/diagnosis.repo.js";
import { AppError } from "@/core/graph/errors/AppError.js";
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

const NatsCaseGenerationRequestSchema =
  CaseGenerationRequestSchema.and(JobIdSchema);

async function consumeCaseGenerateMessage(msg: JsMsg) {
  // Extract jobId before try/catch so it's accessible in the error handler
  const jobIdResult = JobIdSchema.safeParse(msg.json());
  const jobId = jobIdResult.data?.jobId ?? crypto.randomUUID();

  try {
    console.debug(`[NATS] Received message on ${SUBJECT}:`, msg.json());
    const data = NatsCaseGenerationRequestSchema.parse(msg.json());
    const {
      icd,
      userInstructions,
      generationFlags,
      language,
      llmConfig,
      anamnesisCategories,
    } = data;
    let { diagnosis } = data;

    // fill diagnosis and icdCode - zod makes sure that at least one is filled
    if (!diagnosis) {
      // if diagnosis is missing, icd is provided
      diagnosis = await IcdToDiagnosisName(icd!);
      // verify that is set now, otherwise return error
      if (!diagnosis) {
        throw new Error("No diagnosis found for icd");
      }
    }

    console.log(`[NATS] Generating case for ${diagnosis} (jobId=${jobId})`);
    const generatedCase = await runWithContext(
      () =>
        generateCase(
          { name: diagnosis, icd },
          generationFlags,
          userInstructions,
          language,
          anamnesisCategories
        ),
      jobId,
      llmConfig
    );

    bus.emit("Generation Completed", { case: generatedCase, jobId });
    await publishCaseGenerationResponse(
      jobId,
      generatedCase as Record<string, unknown>
    );
    msg.ack();
  } catch (err) {
    console.error(`[NATS] Error processing message:`, err);

    if (err instanceof Error && err.name === "AbortError") {
      bus.emit("Generation Cancelled", { jobId });
      try {
        await publishCaseGenerationResponse(jobId, {
          error: {
            code: "GENERATION_CANCELLED",
            message: "Generation was cancelled",
            details: err.message,
          },
        });
        msg.ack();
      } catch (pubErr) {
        console.error("[NATS] Failed to publish cancel response:", pubErr);
        msg.nak();
      }
      return;
    }

    if (err instanceof Error) {
      bus.emit("Generation Failure", { error: err, jobId });
    }

    let errorPayload: Record<string, unknown>;
    if (err instanceof AppError) {
      errorPayload = {
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      };
    } else {
      errorPayload = {
        error: {
          code: "GENERATION_FAILED",
          message: "An unexpected error occurred",
          details: err instanceof Error ? err.message : String(err),
        },
      };
    }

    try {
      await publishCaseGenerationResponse(jobId, errorPayload);
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

export async function startCaseGenerationConsumer() {
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
    consumeCaseGenerateMessage(msg);
  }
}
