import { EventEmitter } from "node:events";
import type { Language } from "@/core/graph/models/Language.js";

/**
 * Emits two internal event names, `"trace"` and `"label"` — kept as
 * separate `EventEmitter` events (not a single `"event"` with a `type`
 * discriminant) for the same reason `sse/router.ts` writes them as separate
 * SSE `event:` types (issue 15 §3): only one of them is meant for an end
 * user, and a consumer of one should never have to filter the other out of
 * its own handler.
 */
export class TraceBus extends EventEmitter {}

/**
 * Trace payloads get a size cap, not the node's full output (issue 15 §1.3):
 * case outlines are large and some node outputs are binary (issue 11).
 * Never the node's raw output when it exceeds this — `bytes`/`preview`
 * instead. See `tracePayload.ts`'s `buildTracePayload`, the only producer of
 * this type.
 */
export type TracePayload =
  | { truncated: false; value: unknown }
  | { truncated: true; bytes: number; preview: string };

/**
 * The operator-facing trace channel's event shape (issue 15 §3) —
 * node-bound and typed, replacing the old `{jobId, type, timestamp,
 * payload: any}` with its eslint-suppressed `any`. Every event carries the
 * **LangGraph node id** as `nodeId`, the same string `GET /api/graph`
 * (`tracing/structure/`) reports for that node, so a client can key one
 * against the other. `labelKey` is always the English label key (issue 15
 * §1.2) — traces are English, always; a transport wanting a localized
 * string uses the separate `label` SSE event (`LabelEvent` below) instead.
 */
export type TraceEvent =
  | {
      kind: "node_started";
      jobId: string;
      nodeId: string;
      labelKey: string;
      timestamp: string;
    }
  | {
      kind: "node_completed";
      jobId: string;
      nodeId: string;
      labelKey: string;
      timestamp: string;
      output: TracePayload;
    }
  | {
      kind: "node_failed";
      jobId: string;
      nodeId: string;
      labelKey: string;
      timestamp: string;
      error: string;
    }
  | {
      kind: "generation_completed";
      jobId: string;
      timestamp: string;
      case: unknown;
    }
  | {
      kind: "generation_failed";
      jobId: string;
      timestamp: string;
      error: string;
    }
  | {
      kind: "generation_cancelled";
      jobId: string;
      timestamp: string;
    };

/**
 * The end-user-facing channel's event shape: one short, already-localized
 * phrase per node execution, keyed by the same `nodeId` as `TraceEvent` and
 * `GET /api/graph`. `status` lets a progress UI pick an icon (spinner /
 * check / error) without inspecting anything else. Never carries node
 * output — that is exactly what makes it safe to have no size cap and no
 * English-only rule: it is always small, and it is meant to be read by the
 * person who submitted the request.
 */
export type LabelEvent = {
  jobId: string;
  nodeId: string;
  status: "started" | "completed" | "failed";
  /** Localized, falling back to English — see `tracing/index.ts`'s `localizeLabel`. */
  label: string;
  timestamp: string;
};

/** Per-job bookkeeping backing the deterministic teardown below. */
interface JobTraceState {
  bus: TraceBus;
  /** Live SSE (or other) consumers currently subscribed to this job's bus. */
  consumers: number;
  /** Set once `runWithContext`'s `finish()` calls this job's `cleanup()`. */
  terminal: boolean;
  /** The backstop timer armed once `terminal` — see `setupTracing`'s doc comment. */
  backstop?: ReturnType<typeof setTimeout>;
}

const jobs = new Map<string, JobTraceState>();

/**
 * The request's language, per active job — set by `setupTracing` (called via
 * `registerJobHook`, see `utils/context.ts`) so trace-label localization
 * (`index.ts`'s `emitToTraceBus`) knows which language to translate into
 * without core ever carrying `language` on `RequestContext`.
 */
const jobLanguages = new Map<string, Language>();

/**
 * Generous fallback for a client that never disconnects (a hung connection,
 * a proxy that swallows FIN) — this is the *backstop*, not the mechanism.
 * The mechanism is `maybeTeardown`: it runs on every consumer disconnect and
 * on every terminal transition, and tears the bus down the instant both
 * conditions hold, with no artificial delay.
 */
const BACKSTOP_MS = 5 * 60 * 1000;

export function getTraceBus(jobId: string): TraceBus | undefined {
  return jobs.get(jobId)?.bus;
}

export function getJobLanguage(jobId: string): Language | undefined {
  return jobLanguages.get(jobId);
}

function teardown(jobId: string): void {
  const state = jobs.get(jobId);
  if (!state) return;
  clearTimeout(state.backstop);
  jobs.delete(jobId);
  jobLanguages.delete(jobId);
  state.bus.removeAllListeners();
}

/**
 * Tear the bus down the moment it is both terminal (`cleanup()` was called —
 * the job reached a terminal state) **and** has no live consumers. Called
 * from every place either half of that condition can change: `cleanup()`
 * itself, and `registerConsumer`/`unregisterConsumer` below. This is the
 * issue 15 §2 fix for the old hardcoded `setTimeout(..., 10000)`: teardown
 * is now a function of observable state, not a guess at how long "long
 * enough" is.
 */
function maybeTeardown(jobId: string): void {
  const state = jobs.get(jobId);
  if (!state) return;
  if (state.terminal && state.consumers <= 0) teardown(jobId);
}

/** A consumer (an SSE connection today) has subscribed to this job's bus. */
export function registerConsumer(jobId: string): void {
  const state = jobs.get(jobId);
  if (state) state.consumers += 1;
}

/**
 * A consumer has disconnected. If the job is already terminal and this was
 * the last consumer, the bus is torn down right here — deterministically,
 * not on a timer.
 */
export function unregisterConsumer(jobId: string): void {
  const state = jobs.get(jobId);
  if (!state) return;
  state.consumers = Math.max(0, state.consumers - 1);
  maybeTeardown(jobId);
}

export function setupTracing(
  jobId: string,
  language?: Language
): {
  cleanup: () => void;
  bus: TraceBus;
} {
  const bus = new TraceBus();
  jobs.set(jobId, { bus, consumers: 0, terminal: false });
  if (language) jobLanguages.set(jobId, language);

  /**
   * Called by `runWithContext`'s `finish()` when the job's promise settles
   * — success or failure, i.e. exactly "the job reached a terminal state"
   * (issue 15 §2). If nobody is currently subscribed, tear down right away:
   * there is nothing left to send anything to. If a consumer is still
   * reading (an SSE stream that keeps the connection open past the
   * terminal event to receive it), arm the backstop and wait for that
   * consumer's own disconnect to bring the count to zero.
   */
  const cleanup = () => {
    const state = jobs.get(jobId);
    if (!state) return;
    state.terminal = true;
    if (state.consumers > 0) {
      state.backstop = setTimeout(() => teardown(jobId), BACKSTOP_MS);
    }
    maybeTeardown(jobId);
  };

  return { cleanup, bus };
}
