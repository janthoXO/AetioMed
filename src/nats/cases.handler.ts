import { CaseGenerationRequestSchema } from "@/dtos/CaseGenerationRequest.js";
import { getJetStreamClient, getNatsConnection } from "./client.js";
import { AckPolicy, jetstreamManager, type JsMsg } from "@nats-io/jetstream";
import { generateCase } from "@/services/cases.service.js";
import { publishCaseGenerationResponse } from "./cases.publisher.js";

const STREAM_NAME = "cases";
const SUBJECT = "cases.generate";
const CONSUMER_NAME = "cases-generate-consumer";

async function consumeCaseGenerateMessage(msg: JsMsg) {
  try {
    console.debug(`[NATS] Received message on ${SUBJECT}:`, msg.json());
    const data = CaseGenerationRequestSchema.parse(msg.json());

    console.log(`[NATS] Generating case for ${data.diagnosis}`);
    const generatedCase = await generateCase(
      data.diagnosis,
      data.context,
      data.generationFlags
    );

    await publishCaseGenerationResponse(msg.headers, generatedCase);
    msg.ack();
  } catch (err) {
    console.error(`[NATS] Error processing message:`, err);
    // Decide if we should nak or just term?
    // msg.nak(); // Retry later
    msg.term(); // Give up (avoids infinite loops on bad input)
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
