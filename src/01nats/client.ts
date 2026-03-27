import { connect, type NatsConnection } from "@nats-io/transport-node";
import { config } from "../config.js";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";

let nc: NatsConnection | undefined;
let js: JetStreamClient | undefined;

export async function connectNats(): Promise<boolean> {
  if (nc) return true;

  if (!config.nats?.url) {
    console.warn(
      "[NATS] ⚠️ NATS_URL not configured. Skipping NATS connection."
    );
    return false;
  }

  console.log(`[NATS] Connecting to ${config.nats?.url}...`);
  nc = await connect({
    servers: config.nats?.url,
    user: config.nats?.user,
    pass: config.nats?.password,
  });
  console.log(`[NATS] Connected to ${config.nats?.url}`);

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
