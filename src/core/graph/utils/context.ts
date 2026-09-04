import { AsyncLocalStorage } from "node:async_hooks";
import {
  LLMConfigSchema,
  type LLMConfig,
} from "@/core/graph/models/LLMConfig.js";
import type { Language } from "@/core/graph/models/Language.js";
import * as cancelManager from "./cancelManager.js";
import z from "zod";

/**
 * Deliberately **without** `language` (issue 09 §2) — this schema doubles as
 * LangGraph's own runtime-context schema at every
 * `new StateGraph(state, RequestContextSchema)` call site, and language must
 * never reach that context (subgraph *state* is filtered by the child's
 * schema; subgraph *context* is not, so a field placed here would leak
 * across every subgraph boundary regardless of scoping). `language` is
 * carried on `RequestContext` below (the ALS-only type), never on this
 * zod-validated one, so it structurally cannot end up in any object built
 * for LangGraph's `context` invoke option.
 */
export const RequestContextSchema = z.object({
  jobId: z.string().optional(),
  llmConfig: LLMConfigSchema.optional(),
});

/**
 * `language` (issue 09 §2) is re-added here deliberately, after an earlier
 * PR deleted it from `RequestContextSchema` for being declared and never
 * populated — dead weight implying a mechanism that did not exist. It comes
 * back as the *live* mechanism, but only on this ALS-only type, never on
 * `RequestContextSchema` (see that schema's comment for why): `runWithContext`
 * already accepted `language` (to pass to the job hook below); it now also
 * stores it here, and ports read it via `getRequestContext()` — never off
 * graph state, and never off LangGraph's own runtime context. That is what
 * "language is a property of the bound ports" means mechanically —
 * `GraphRuntime.languageOverride` (`runtime.ts`) is the other half, for the
 * one binding that needs to *override* rather than just read the ambient
 * value (the sandwich-on generation phase).
 *
 * Known limitation, carried forward from `llmConfig`: ALS-carried values
 * are invisible to checkpoints, so anything resumable (F09) must rebuild
 * `language` from the original request rather than expect it to survive
 * a resume. Not solved here.
 */
export type RequestContext = z.infer<typeof RequestContextSchema> & {
  signal?: AbortSignal;
  language?: Language | undefined;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Core-owned hook a per-job resource can register itself against, without
 * core importing the module that provides it (see the `tracing`
 * module's `wireTracing()`, which calls `registerJobHook`). `runWithContext`
 * calls the registered hook, if any, for every job, passing along the
 * request's language so that hook can localize per-job output (e.g. trace
 * labels) — this is a separate, one-shot delivery at job start, not a read
 * off `RequestContext` (the hook runs before `requestContext.run` below).
 * With no hook registered (`TRACING` unset) this allocates nothing — no
 * `TraceBus`, no per-request work — unlike the previous unconditional
 * `setupTracing()` import/call.
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
      { jobId, llmConfig, language, signal: controller.signal },
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
