import { AsyncLocalStorage } from "node:async_hooks";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/models/LLMConfig.js";
import type { Language } from "@/core/graph/models/Language.js";
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

/**
 * Core-owned hook a per-job resource can register itself against, without
 * core importing the module that provides it (see the `tracing`
 * module's `wireTracing()`, which calls `registerJobHook`). `runWithContext`
 * calls the registered hook, if any, for every job, passing along the
 * request's language purely so that hook can localize per-job output (e.g.
 * trace labels) — the language itself is never stored on `RequestContext`;
 * nothing reads it off the ALS-carried context. With no hook registered
 * (`TRACING` unset) this allocates nothing — no `TraceBus`, no per-request
 * work — unlike the previous unconditional `setupTracing()` import/call.
 */
type JobHook = (jobId: string, language?: Language) => { cleanup: () => void };
let jobHook: JobHook | undefined;

export function registerJobHook(hook: JobHook): void {
  jobHook = hook;
}

export function runWithContext<T>(
  fn: () => T,
  jobId?: string,
  llmConfig?: LLMConfig,
  language?: Language
): T {
  const controller = new AbortController();
  let cleanup: (() => void) | undefined;

  if (jobId) {
    ({ cleanup } = jobHook?.(jobId, language) ?? {});
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
