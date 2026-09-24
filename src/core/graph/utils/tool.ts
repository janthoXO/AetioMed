import type { z } from "zod";
import type { RequestContext } from "./context.js";
import type { GraphRuntime } from "../runtime.js";

/**
 * Named, schema-validated capability called by graph nodes. Prompting, LLM
 * calls, retries, parsing live in `invoke`; nodes are thin.
 *
 * `runtime`: process-wide ports. `context`: per-request data (jobId,
 * llmConfig, abort signal) from ALS.
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
