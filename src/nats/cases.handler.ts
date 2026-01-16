import { CaseGenerationRequestSchema } from "@/dtos/CaseGenerationRequest.js";
import { getJetStreamClient, getNatsConnection } from "./client.js";
import { AckPolicy, jetstreamManager, type JsMsg } from "@nats-io/jetstream";
import { generateCase } from "@/services/cases.service.js";
import { publishCaseGenerationResponse } from "./cases.publisher.js";
import { IcdToDiseaseName } from "@/services/diseases.service.js";
import { AppError } from "@/errors/AppError.js";

const STREAM_NAME = "cases";
const SUBJECT = "cases.generate";
const CONSUMER_NAME = "cases-generate-consumer";

async function consumeCaseGenerateMessage(msg: JsMsg) {
  try {
    console.debug(`[NATS] Received message on ${SUBJECT}:`, msg.json());
    const data = CaseGenerationRequestSchema.parse(msg.json());
    const { icd, context, generationFlags, language } = data;
    let { diagnosis } = data;

    // fill diagnosis and icdCode - zod makes sure that at least one is filled
    if (!diagnosis) {
      // if diagnosis is missing, icd is provided
      diagnosis = await IcdToDiseaseName(icd!);
      // verify that is set now, otherwise return error
      if (!diagnosis) {
        throw new Error("No diagnosis found for icd");
        return;
      }
    }

    console.log(`[NATS] Generating case for ${diagnosis}`);
    const generatedCase = await generateCase(
      icd,
      diagnosis,
      generationFlags,
      context,
      language
    );

    await publishCaseGenerationResponse(msg.headers, generatedCase);
    msg.ack();
  } catch (err) {
    console.error(`[NATS] Error processing message:`, err);

    let errorResponse;
    if (err instanceof AppError) {
      errorResponse = {
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      };
    } else {
      errorResponse = {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred",
          details: err instanceof Error ? err.message : String(err),
        },
      };
    }

    try {
      await publishCaseGenerationResponse(msg.headers, errorResponse);
      msg.ack(); // Ack even on error because we processed it by sending an error response
    } catch (pubErr) {
      console.error("[NATS] Failed to publish error response:", pubErr);
      msg.nak(); // Retry if we couldn't publish the error
    }
  }
}

export async function startCaseGenerationConsumer() {
  const nc = getNatsConnection();
  const js = getJetStreamClient();
  const jsm = await jetstreamManager(nc);

  // const streamExists = (await jsm.streams.list().next()).find((s) => s.config.name === STREAM_NAME);

  const streamInf = await jsm.streams.info(STREAM_NAME).catch(() => null);
  if (!streamInf) {
    console.log(`[NATS] Creating stream ${STREAM_NAME}...`);
    await jsm.streams.add({
      name: STREAM_NAME,
      subjects: [`${STREAM_NAME}.>`],
      retention: "workqueue",
      storage: "file",
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

  console.log(`[NATS] subscribing to ${SUBJECT}`);
  const consumer = await js.consumers.get(STREAM_NAME, CONSUMER_NAME);
  const messages = await consumer.consume({ max_messages: 1 });
  for await (const msg of messages) {
    consumeCaseGenerateMessage(msg);
  }
}
