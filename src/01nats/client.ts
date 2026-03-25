import { connect, type NatsConnection } from "@nats-io/transport-node";
import { config } from "../config.js";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";

let nc: NatsConnection | undefined;
let js: JetStreamClient | undefined;

export async function connectNats(): Promise<boolean> {
  if (nc) return true;

  if (!config.NATS_URL) {
    console.warn(
      "[NATS] ⚠️ NATS_URL not configured. Skipping NATS connection."
    );
    return false;
  }

  console.log(`[NATS] Connecting to ${config.NATS_URL}...`);
  nc = await connect({
    servers: config.NATS_URL,
    user: config.NATS_USER,
    pass: config.NATS_PASSWORD,
  });
  console.log(`[NATS] Connected to ${config.NATS_URL}`);

  js = jetstream(nc);
  return true;
}

export function getJetStreamClient(): JetStreamClient {
  if (!js) {
    throw new Error(
      "NATS JetStream not initialized. Call connectNats() first."
    );
  }

  return js;
}

export function getNatsConnection(): NatsConnection {
  if (!nc) {
    throw new Error(
      "NATS Connection not initialized. Call connectNats() first."
    );
  }

  return nc;
}

export async function closeNats() {
  if (!nc) {
    return;
  }

  await nc.close();
  console.log("[NATS] Connection closed");
  nc = undefined;
  js = undefined;
}
