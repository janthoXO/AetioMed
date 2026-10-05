// Per-job event channel. Core owns it; transports subscribe.
import type { LabelEvent } from "./labels.js";

/**
 * Event types by name. Extendable by module augmentation, like `EventBus`'s
 * `EventMap`. Name is the SSE `event:` name on REST and last subject token on
 * NATS (`cases.progress.<jobId>.<name>`); no mapping table.
 */
export interface JobEventMap {
  /** The job was accepted and its channel opened. Always the first event. */
  accepted: JobAcceptedEvent;
  /** A node started or reached a terminal status — see `labels.ts`. */
  label: LabelEvent;
  /** The job reached a terminal state. Always the last event. */
  complete: JobCompleteEvent;
}

export type JobEventType = keyof JobEventMap;

export type JobEvent = {
  [K in JobEventType]: { type: K; data: JobEventMap[K] };
}[JobEventType];

export type JobAcceptedEvent = { jobId: string; timestamp: string };

/**
 * `planned`: plan-mode call stopped at its plan. Job over; a later call
 * carrying the plan may reuse this jobId (see {@link JobEventChannel.open}).
 */
export type JobOutcome =
  | { status: "done" }
  | { status: "planned" }
  | { status: "cancelled" }
  | { status: "failed"; error: { code: string; message: string } };

/** Terminal marker, **without** the case: observers are not the requester. */
export type JobCompleteEvent = {
  jobId: string;
  timestamp: string;
} & JobOutcome;

export type JobListener = (event: JobEvent) => void;
export type GlobalJobListener = (jobId: string, event: JobEvent) => void;

export type SubscribeResult =
  | { state: "active"; unsubscribe: () => void }
  | { state: "terminal"; complete: JobCompleteEvent }
  | { state: "unknown" };

export type JobPeek =
  | { state: "active" }
  | { state: "terminal"; complete: JobCompleteEvent }
  | { state: "unknown" };

export interface JobEventChannel {
  /**
   * Reserve `jobId`, open channel. `false` if id in use: running, or
   * finished within {@link TOMBSTONE_MS} (jobId is idempotency key). Exempt:
   * `planned` (continuation reuses jobId) and `cancelled` (REST disconnect
   * resend must run). Those are forgotten and id reopened.
   */
  open(jobId: string): boolean;
  /** Deliver an event to the job's subscribers. Dropped if the job is not active. */
  publish<K extends JobEventType>(
    jobId: string,
    type: K,
    data: JobEventMap[K]
  ): void;
  /** The job reached a terminal state: publish `complete` and stop accepting events. */
  close(jobId: string, outcome: JobOutcome): void;
  /**
   * Subscribe to one job. State check and attach are one step; no event
   * lost. Terminal job returns its `complete` event instead.
   */
  subscribe(jobId: string, listener: JobListener): SubscribeResult;
  /**
   * Subscribe to every job (NATS progress publisher). Not a consumer of any
   * one job; never holds resources open.
   */
  subscribeAll(listener: GlobalJobListener): () => void;
  /** Whether a job is running, finished recently, or was never seen here. */
  state(jobId: string): "active" | "terminal" | "unknown";
  /** {@link state}, plus the `complete` event of a terminal job. Never subscribes. */
  peek(jobId: string): JobPeek;
}

/**
 * Backstop for a consumer that never disconnects. Normal teardown is
 * {@link maybeTeardown}: terminal **and** last subscriber gone.
 */
export const BACKSTOP_MS = 5 * 60 * 1000;

/**
 * How long a finished job's `complete` event is kept after teardown.
 * Distinguishes "finished" from "never existed"; makes reused jobId a
 * detectable duplicate. Not a result store.
 */
export const TOMBSTONE_MS = 10 * 60 * 1000;

interface JobState {
  listeners: Set<JobListener>;
  complete?: JobCompleteEvent;
  backstop?: ReturnType<typeof setTimeout>;
}

/**
 * Build a channel. One instance from `app.ts`, shared by service and
 * transports; not a singleton.
 */
export function createJobEventChannel(): JobEventChannel {
  const jobs = new Map<string, JobState>();
  const tombstones = new Map<
    string,
    { complete: JobCompleteEvent; evict: ReturnType<typeof setTimeout> }
  >();
  const globalListeners = new Set<GlobalJobListener>();

  // Throwing listener must not break others or the emitting node
  // (`publish` runs inside `traceNode`'s bus emit).
  function deliver(jobId: string, state: JobState, event: JobEvent): void {
    for (const listener of [...state.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[jobEvents] Listener failed for jobId=${jobId}`, error);
      }
    }
    for (const listener of [...globalListeners]) {
      try {
        listener(jobId, event);
      } catch (error) {
        console.error(`[jobEvents] Listener failed for jobId=${jobId}`, error);
      }
    }
  }

  function teardown(jobId: string): void {
    const state = jobs.get(jobId);
    if (!state) return;
    clearTimeout(state.backstop);
    state.listeners.clear();
    jobs.delete(jobId);
    if (state.complete) {
      const evict = setTimeout(() => tombstones.delete(jobId), TOMBSTONE_MS);
      evict.unref?.();
      tombstones.set(jobId, { complete: state.complete, evict });
    }
  }

  function maybeTeardown(jobId: string): void {
    const state = jobs.get(jobId);
    if (state?.complete && state.listeners.size === 0) teardown(jobId);
  }

  return {
    open(jobId) {
      const prior =
        jobs.get(jobId)?.complete ?? tombstones.get(jobId)?.complete;
      if (prior?.status === "planned" || prior?.status === "cancelled") {
        teardown(jobId);
        clearTimeout(tombstones.get(jobId)?.evict);
        tombstones.delete(jobId);
      }
      if (jobs.has(jobId) || tombstones.has(jobId)) return false;
      const state: JobState = { listeners: new Set() };
      jobs.set(jobId, state);
      deliver(jobId, state, {
        type: "accepted",
        data: { jobId, timestamp: new Date().toISOString() },
      });
      return true;
    },

    publish(jobId, type, data) {
      const state = jobs.get(jobId);
      if (!state || state.complete) return;
      deliver(jobId, state, { type, data } as JobEvent);
    },

    close(jobId, outcome) {
      const state = jobs.get(jobId);
      if (!state || state.complete) return;
      const complete: JobCompleteEvent = {
        jobId,
        timestamp: new Date().toISOString(),
        ...outcome,
      };
      state.complete = complete;
      deliver(jobId, state, { type: "complete", data: complete });
      if (state.listeners.size > 0) {
        state.backstop = setTimeout(() => teardown(jobId), BACKSTOP_MS);
        state.backstop.unref?.();
      }
      maybeTeardown(jobId);
    },

    subscribe(jobId, listener) {
      const state = jobs.get(jobId);
      if (state?.complete)
        return { state: "terminal", complete: state.complete };
      if (state) {
        state.listeners.add(listener);
        return {
          state: "active",
          unsubscribe: () => {
            state.listeners.delete(listener);
            maybeTeardown(jobId);
          },
        };
      }
      const tombstone = tombstones.get(jobId);
      if (tombstone) return { state: "terminal", complete: tombstone.complete };
      return { state: "unknown" };
    },

    subscribeAll(listener) {
      globalListeners.add(listener);
      return () => globalListeners.delete(listener);
    },

    peek(jobId) {
      const state = jobs.get(jobId);
      if (state?.complete)
        return { state: "terminal", complete: state.complete };
      if (state) return { state: "active" };
      const tombstone = tombstones.get(jobId);
      if (tombstone) return { state: "terminal", complete: tombstone.complete };
      return { state: "unknown" };
    },

    state(jobId) {
      const state = jobs.get(jobId);
      if (state) return state.complete ? "terminal" : "active";
      return tombstones.has(jobId) ? "terminal" : "unknown";
    },
  };
}
