import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";
import type { Config } from "./config.js";

let nc: NatsConnection | undefined;
let js: JetStreamClient | undefined;

export async function connectNats(natsConfig: Config): Promise<boolean> {
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

  // Deliberately `nc.close()`, not `nc.drain()` (issue 18): draining would
  // wait for in-flight messages to finish, and a case generation runs for
  // minutes — that would always blow the shutdown deadline. Out of scope.
  await nc.close();
  console.log("[NATS] Connection closed");
  nc = undefined;
  js = undefined;
}
