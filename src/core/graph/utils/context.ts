import { AsyncLocalStorage } from "node:async_hooks";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/models/LLMConfig.js";
import { LanguageSchema } from "@/core/graph/models/Language.js";
import * as cancelManager from "./cancelManager.js";
import z from "zod";

export const RequestContextSchema = z.object({
  jobId: z.string().optional(),
  llmConfig: LLMConfigSchema.optional(),
  language: LanguageSchema.optional(),
});

export type RequestContext = z.infer<typeof RequestContextSchema> & {
  signal?: AbortSignal;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Core-owned hook a per-job resource can register itself against, without
 * core importing the extension that provides it (see the `tracing`
 * extension's `setup()`, which calls `registerJobHook`). `runWithContext`
 * calls the registered hook, if any, for every job. With no hook registered
 * (`TRACING` unset) this allocates nothing — no `TraceBus`, no per-request
 * work — unlike the previous unconditional `setupTracing()` import/call.
 */
type JobHook = (jobId: string) => { cleanup: () => void };
let jobHook: JobHook | undefined;

export function registerJobHook(hook: JobHook): void {
  jobHook = hook;
}

export function runWithContext<T>(
  fn: () => T,
  jobId?: string,
  llmConfig?: LLMConfig
): T {
  const controller = new AbortController();
  let cleanup: (() => void) | undefined;

  if (jobId) {
    ({ cleanup } = jobHook?.(jobId) ?? {});
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
