import type { EventBus } from "../event-bus.js";
import type { Case } from "./models/Case.js";
import { ConfigSchema, type Config } from "./config.js";

declare module "../event-bus.js" {
  interface EventMap {
    "Generation Completed": { case: Case; additionalData?: object };
    "Generation Failure": { error: Error; additionalData?: object };
    "Generation Log": {
      msg: string;
      logLevel: "info" | "warn" | "error";
      timestamp: string;
      additionalData?: object;
    };
    "Node Started": { node: string; traceId?: string; timestamp: string };
    "Node Completed": {
      node: string;
      result: unknown;
      traceId?: string;
      timestamp: string;
    };
  }
}

export let config: Config;
export let bus: EventBus;

/** Called once from app.ts before any extension loads. */
export function initGraph(opts: { bus: EventBus; config: Config }): void {
  bus = opts.bus;
  config = opts.config;

  console.log(
    `[graph] Initialized with ${
      opts.config.allowedLlms
        ? "dynamic LLMs"
        : (opts.config.llm?.provider ?? "?") +
          "/" +
          (opts.config.llm?.model ?? "?")
    } configuration.`
  );
}

export { ConfigSchema };

// Surface consumed by transport extensions (rest, nats)
export { caseGraph, generateCase } from "./02graphs/caseGraph.js";
export { runWithContext } from "./utils/context.js";
