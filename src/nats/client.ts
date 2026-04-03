import { connect, type NatsConnection } from "@nats-io/transport-node";
import { natsConfig } from "./config.js";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";

let nc: NatsConnection | undefined;
let js: JetStreamClient | undefined;

export async function connectNats(): Promise<boolean> {
  if (nc) return true;

  console.log(`[NATS] Connecting to ${natsConfig.url}...`);
  nc = await connect({
    servers: natsConfig.url,
    user: natsConfig.user,
    pass: natsConfig.password,
  });
  console.log(`[NATS] Connected to ${natsConfig.url}`);

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
