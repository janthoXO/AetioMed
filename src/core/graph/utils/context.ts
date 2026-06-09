import { AsyncLocalStorage } from "node:async_hooks";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/models/LLMConfig.js";
import { setupTracing } from "@/extensions/tracing/traceManager.js";
import * as cancelManager from "./cancelManager.js";
import z from "zod";

export const RequestContextSchema = z.object({
  jobId: z.string().optional(),
  llmConfig: LLMConfigSchema.optional(),
});

export type RequestContext = z.infer<typeof RequestContextSchema> & {
  signal?: AbortSignal;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(
  fn: () => T,
  jobId?: string,
  llmConfig?: LLMConfig
): T {
  const controller = new AbortController();
  let cleanup: (() => void) | undefined;

  if (jobId) {
    ({ cleanup } = setupTracing(jobId));
    cancelManager.register(jobId, controller);
  }

  const finish = () => {
    if (jobId) cancelManager.unregister(jobId);
    cleanup?.();
  };

  try {
    const result = requestContext.run(
      { jobId, llmConfig, signal: controller.signal },
      fn
    );
    if (result instanceof Promise) {
      return result.finally(finish) as unknown as T;
    }
    finish();
    return result;
  } catch (error) {
    finish();
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
