import type { EventBus } from "../event-bus.js";
import type { Case } from "./models/Case.js";
import { ConfigSchema, type Config } from "./config.js";
import { validateCatalogsOrExit } from "./catalog/startupValidation.js";

declare module "../event-bus.js" {
  interface EventMap {
    "Generation Completed": {
      case: Case;
      jobId?: string;
      additionalData?: object;
    };
    "Generation Failure": {
      error: Error;
      jobId?: string;
      additionalData?: object;
    };
    "Generation Cancelled": {
      jobId?: string;
    };
    "Generation Log": {
      msg: string;
      logLevel: "info" | "warn" | "error";
      timestamp: string;
      additionalData?: object;
    };
    "Node Started": {
      node: string;
      label?: string;
      jobId?: string;
      timestamp: string;
    };
    "Node Completed": {
      node: string;
      label?: string;
      result: unknown;
      jobId?: string;
      timestamp: string;
    };
  }
}

export let config: Config;
export let bus: EventBus;

/** Called once from app.ts before any extension loads. */
export function initGraph(opts: { bus: EventBus; config: Config }): void {
  // Validate catalogue translation files here, and not at module scope: the
  // "labels" catalogue's base key set is `getKnownLabels()`
  // (utils/nodeWrapper.ts), which `traceNode` populates as the graph modules
  // are constructed at *import time*. This module re-exports `caseGraph`
  // below, so by the time this function's *body* runs — which app.ts only
  // does after importing this module — every graph module has already been
  // imported and every label registered. Running the validation any earlier
  // (e.g. at this module's own top level) would validate labels against an
  // empty set and silently pass.
  validateCatalogsOrExit();

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
export * as cancelManager from "./utils/cancelManager.js";
