import { AsyncLocalStorage } from "node:async_hooks";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/models/LLMConfig.js";
import type { Language } from "@/core/graph/models/Language.js";
import z from "zod";

/**
 * No `language` here: this schema is also LangGraph's runtime-context schema,
 * and subgraph context is not filtered by child schema, so a field here would
 * leak across every subgraph. `language` lives on ALS-only `RequestContext`.
 */
export const RequestContextSchema = z.object({
  jobId: z.string().optional(),
  llmConfig: LLMConfigSchema.optional(),
});

/**
 * ALS-carried context. `runWithContext` stores `language`; ports read it via
 * `getRequestContext()`, never graph state or LangGraph context.
 * `GraphRuntime.languageOverride` overrides the ambient value where needed.
 * ALS values are invisible to checkpoints.
 */
export type RequestContext = z.infer<typeof RequestContextSchema> & {
  signal?: AbortSignal;
  language?: Language | undefined;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Bind request context for duration of `fn`. `signal` is the job's abort
 * signal; `CaseGenerationService` owns cancellation.
 */
export function runWithContext<T>(
  fn: () => T,
  jobId?: string,
  llmConfig?: LLMConfig,
  language?: Language,
  signal: AbortSignal = new AbortController().signal
): T {
  return requestContext.run({ jobId, llmConfig, language, signal }, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
