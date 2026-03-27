import { AsyncLocalStorage } from "node:async_hooks";
import { LLMConfigSchema, type LLMConfig } from "@/models/LLMConfig.js";
import { setupTracing, TraceUtilsSchema } from "./traceManager.js";
import z from "zod";

export const RequestContextSchema = z.object({
  llmConfig: LLMConfigSchema.optional(),
  traceUtils: TraceUtilsSchema.optional(),
});

export type RequestContext = z.infer<typeof RequestContextSchema>;

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(
  fn: () => T,
  traceId?: string,
  llmConfig?: LLMConfig
): T {
  let traceUtils = undefined;
  let cleanup = undefined;

  if (traceId) {
    ({ traceUtils, cleanup } = setupTracing(traceId));
  }

  try {
    const result = requestContext.run({ llmConfig, traceUtils }, fn);
    if (result instanceof Promise) {
      result.finally(cleanup);
    } else {
      cleanup?.();
    }
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
