import type { z } from "zod";
import type { RequestContext } from "./context.js";
import type { GraphRuntime } from "../runtime.js";

/**
 * A named, schema-validated capability callable by graph nodes and exposable via MCP.
 * Prompt construction, LLM invocation, retries, and structured-output parsing
 * all live inside `invoke` — nodes are thin pass-throughs.
 *
 * `runtime` carries the process-wide ports (LLM, catalogues, logger, clock);
 * `context` carries the per-request data (jobId, per-request llmConfig,
 * abort signal) from the existing `AsyncLocalStorage`.
 */
export interface Tool<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  invoke: (
    input: TInput,
    runtime: GraphRuntime,
    context?: RequestContext
  ) => Promise<TOutput>;
}
