import {
  AckPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type JetStreamManager,
  type StreamInfo,
} from "@nats-io/jetstream";
import {
  LEGACY_STREAM,
  REQUESTS_STREAM,
  REQUEST_ACK_WAIT_MS,
  REQUEST_CONSUMER,
  REQUEST_SUBJECT,
  STREAMS,
  reviewsStream,
} from "./subjects.js";

async function streamInfo(
  jsm: JetStreamManager,
  name: string
): Promise<StreamInfo | null> {
  try {
    return await jsm.streams.info(name);
  } catch (error) {
    if (
      error instanceof JetStreamApiError &&
      error.code === JetStreamApiCodes.StreamNotFound
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Create `CASE_REQUESTS`, `CASE_RESULTS` and `CASE_REVIEWS` (#159), or
 * reconcile their subjects and limits if they exist. Fails loudly rather
 * than guessing in two cases, both of which JetStream cannot fix in place:
 *
 * - the pre-#142 `cases` stream still exists. Its `cases.>` filter overlaps
 *   every stream here, so JetStream would refuse to create them with an
 *   opaque "subjects overlap" error. It is **not** deleted automatically: it
 *   may still hold requests nobody has processed.
 * - a stream exists with a different retention policy — retention cannot be
 *   changed on an existing stream.
 *
 * `reviewTtlMs` is `CASE_REVIEWS`'s `max_age` — the deployment's review time
 * limit (`REVIEW_TTL_MINUTES`), threaded in rather than read from `process.env`
 * here, so this module stays free of environment access.
 */
export async function ensureStreams(
  jsm: JetStreamManager,
  reviewTtlMs: number
): Promise<void> {
  const allStreams = [...STREAMS, reviewsStream(reviewTtlMs)];

  if (await streamInfo(jsm, LEGACY_STREAM)) {
    throw new Error(
      `The pre-#142 JetStream stream "${LEGACY_STREAM}" still exists. Its "cases.>" filter overlaps ` +
        `the new ${allStreams.map((s) => s.name).join(" and ")} streams, and it cannot be migrated ` +
        `in place. Drain or inspect it, then delete it (e.g. \`nats stream rm ${LEGACY_STREAM}\`) and restart.`
    );
  }

  for (const config of allStreams) {
    const info = await streamInfo(jsm, config.name);
    if (!info) {
      console.log(`[NATS] Creating stream ${config.name}...`);
      await jsm.streams.add({ ...config, subjects: [...config.subjects] });
      continue;
    }
    if (info.config.retention !== config.retention) {
      throw new Error(
        `JetStream stream "${config.name}" has retention "${info.config.retention}", expected ` +
          `"${config.retention}". Retention cannot be changed in place; delete the stream ` +
          `(e.g. \`nats stream rm ${config.name}\`) and restart.`
      );
    }
    await jsm.streams.update(config.name, {
      ...info.config,
      ...config,
      subjects: [...config.subjects],
    });
  }

  // The worker's durable pull consumer, shared by every replica.
  const ackWait = REQUEST_ACK_WAIT_MS * 1_000_000;
  try {
    await jsm.consumers.info(REQUESTS_STREAM.name, REQUEST_CONSUMER);
    await jsm.consumers.update(REQUESTS_STREAM.name, REQUEST_CONSUMER, {
      ack_wait: ackWait,
    });
  } catch (error) {
    if (
      !(error instanceof JetStreamApiError) ||
      error.code !== JetStreamApiCodes.ConsumerNotFound
    ) {
      throw error;
    }
    console.log(`[NATS] Creating consumer ${REQUEST_CONSUMER}...`);
    await jsm.consumers.add(REQUESTS_STREAM.name, {
      durable_name: REQUEST_CONSUMER,
      filter_subject: REQUEST_SUBJECT,
      ack_policy: AckPolicy.Explicit,
      ack_wait: ackWait,
    });
  }
}
