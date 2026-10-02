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
  REQUEST_MAX_ATTEMPTS,
  REQUEST_SUBJECT,
  STREAMS,
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
 * Create `CASE_REQUESTS`, `CASE_RESULTS`, `CASE_PLANS`, or reconcile
 * subjects and limits. Throws on two cases JetStream cannot fix in place:
 *
 * - legacy `cases` stream exists. Its `cases.>` filter overlaps every stream
 *   here. Not auto-deleted: may hold unprocessed requests.
 * - stream exists with different retention; retention is immutable.
 */
export async function ensureStreams(jsm: JetStreamManager): Promise<void> {
  if (await streamInfo(jsm, LEGACY_STREAM)) {
    throw new Error(
      `The legacy JetStream stream "${LEGACY_STREAM}" still exists. Its "cases.>" filter overlaps ` +
        `the new ${STREAMS.map((s) => s.name).join(" and ")} streams, and it cannot be migrated ` +
        `in place. Drain or inspect it, then delete it (e.g. \`nats stream rm ${LEGACY_STREAM}\`) and restart.`
    );
  }

  for (const config of STREAMS) {
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
  const maxDeliver = REQUEST_MAX_ATTEMPTS + 1;
  try {
    await jsm.consumers.info(REQUESTS_STREAM.name, REQUEST_CONSUMER);
    await jsm.consumers.update(REQUESTS_STREAM.name, REQUEST_CONSUMER, {
      ack_wait: ackWait,
      max_deliver: maxDeliver,
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
      max_deliver: maxDeliver,
    });
  }
}
