import type { z } from "zod";
import type { RequestContext } from "./context.js";

/**
 * A named, schema-validated capability callable by graph nodes and exposable via MCP.
 * Prompt construction, LLM invocation, retries, and structured-output parsing
 * all live inside `invoke` — nodes are thin pass-throughs.
 */
export interface Tool<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  invoke: (input: TInput, context?: RequestContext) => Promise<TOutput>;
}
