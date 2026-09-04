import type { EventBus } from "../event-bus.js";
import type { Case } from "./models/Case.js";
import { ConfigSchema, type Config } from "./config.js";
import { validateCatalogsOrExit } from "./catalog/startupValidation.js";
import { buildCaseGraph } from "./02graphs/caseGraph.js";
import { createYamlCatalogs } from "./catalog/index.js";
import { createLlmPort } from "./utils/llm.js";
import { createLogger } from "./utils/logger.js";
import type { GraphRuntime } from "./runtime.js";
import type { GraphAppContext } from "./appContext.js";

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

export { ConfigSchema };

/**
 * Build the `GraphRuntime` (ports), construct the graph as a function of it,
 * and validate the catalogues. Called once from `createApp()`, before any
 * extension loads — there is no module-scope mutable state left for
 * extensions to race against.
 */
export function initGraph(opts: {
  bus: EventBus;
  config: Config;
}): GraphAppContext {
  const { bus, config } = opts;

  const runtime: GraphRuntime = {
    llm: createLlmPort(config),
    catalogs: createYamlCatalogs(),
    log: createLogger(bus),
    clock: () => new Date(),
  };

  const { generateCase } = buildCaseGraph(runtime, bus, config);

  // Validate catalogue translation files here, and not any earlier: the
  // "labels" catalogue's base key set is `getKnownLabels()`
  // (utils/nodeWrapper.ts), which `traceNode` populates as `buildCaseGraph`
  // constructs the graph modules above. Running the validation any earlier
  // would validate labels against an empty set and silently pass.
  validateCatalogsOrExit();

  console.log(
    `[graph] Initialized with ${
      config.allowedLlms
        ? "dynamic LLMs"
        : (config.llm?.provider ?? "?") + "/" + (config.llm?.model ?? "?")
    } configuration.`
  );

  return { config, runtime, generateCase };
}

export { runWithContext, registerJobHook } from "./utils/context.js";
export * as cancelManager from "./utils/cancelManager.js";
