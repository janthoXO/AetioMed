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
 * Bind a request's context for the duration of `fn` and register its abort
 * controller with `cancelManager`, so the job can be cancelled by jobId.
 *
 * It used to also call a single-slot `registerJobHook` that the tracing
 * module filled in, so exactly one adapter could attach per job. The per-job
 * event channel is now core-owned and opened by `CaseGenerationService`
 * (`core/jobEvents/`, #139); every adapter subscribes to it instead.
 */
export function runWithContext<T>(
  fn: () => T,
  jobId?: string,
  llmConfig?: LLMConfig,
  language?: Language
): T {
  const controller = new AbortController();

  if (jobId) cancelManager.register(jobId, controller);

  const finish = () => {
    if (jobId) cancelManager.unregister(jobId);
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
