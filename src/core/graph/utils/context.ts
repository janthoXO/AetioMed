import { AsyncLocalStorage } from "node:async_hooks";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/models/LLMConfig.js";
import { setupTracing } from "@/extensions/tracing/traceManager.js";
import z from "zod";

export const RequestContextSchema = z.object({
  jobId: z.string().optional(),
  llmConfig: LLMConfigSchema.optional(),
});

export type RequestContext = z.infer<typeof RequestContextSchema>;

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(
  fn: () => T,
  jobId?: string,
  llmConfig?: LLMConfig
): T {
  let cleanup: (() => void) | undefined;

  if (jobId) {
    ({ cleanup } = setupTracing(jobId));
  }

  try {
    const result = requestContext.run({ jobId, llmConfig }, fn);
    if (result instanceof Promise) {
      return result.finally(() => cleanup?.()) as unknown as T;
    }
    cleanup?.();
    return result;
  } catch (error) {
    cleanup?.();
    throw error;
  }
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function getRequiredRequestContext(): RequestContext {
  const context = requestContext.getStore();
  if (!context) {
    throw new Error("Request context is missing");
  }

  return context;
}
