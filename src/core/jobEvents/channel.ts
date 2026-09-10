// The per-job event channel (#139). Core owns it; every transport is an
// adapter that subscribes to it. It used to live in `src/tracing/` behind a
// single-slot `registerJobHook`, which is why only the SSE adapter ever
// attached and a NATS client had no progress channel at all.
import type { LabelEvent } from "./labels.js";

/**
 * Every event type the channel carries, keyed by name. Filled by module
 * augmentation, the same way `EventBus`'s `EventMap` is: a producer module
 * declares its own event type here without the channel importing it.
 *
 * One name means the same thing on every wire. It is the SSE `event:` name
 * on REST and the last subject token on NATS
 * (`cases.progress.<jobId>.<name>`), so no adapter needs a mapping table.
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

export type JobOutcome =
  | { status: "done" }
  | { status: "cancelled" }
  | { status: "failed"; error: { code: string; message: string } };

/**
 * A terminal marker, deliberately **without** the case: an observer of a
 * job is not its requester, and the result only goes back to the requester
 * (#145, "watch, not collect").
 */
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
   * Reserve `jobId` and open its channel. Returns `false` if the id is
   * already in use: still running, or finished within the last
   * {@link TOMBSTONE_MS}. A jobId is an idempotency key, so a retry of a
   * finished job must not start a second generation either.
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
   * Subscribe to one job. Answers and subscribes in one step, so no event
   * can be lost between checking the state and attaching. A terminal job
   * hands back its `complete` event instead of a subscription.
   */
  subscribe(jobId: string, listener: JobListener): SubscribeResult;
  /**
   * Subscribe to every job. A transport that forwards all jobs (the NATS
   * progress publisher) uses this. It does not count as a consumer of any
   * one job, so it never holds a job's resources open.
   */
  subscribeAll(listener: GlobalJobListener): () => void;
  /** Whether a job is running, finished recently, or was never seen here. */
  state(jobId: string): "active" | "terminal" | "unknown";
  /** {@link state}, plus the `complete` event of a terminal job. Never subscribes. */
  peek(jobId: string): JobPeek;
}

/**
 * A fallback for a consumer that never disconnects (a hung connection, a
 * proxy that swallows the FIN). It is the backstop, not the mechanism. The
 * mechanism is {@link maybeTeardown}: a job's listeners are released the
 * moment it is terminal **and** its last subscriber has gone (issue 15 §2).
 */
export const BACKSTOP_MS = 5 * 60 * 1000;

/**
 * How long a finished job is remembered after teardown: its `complete`
 * event, nothing else. This is what lets "finished" and "never existed" get
 * different answers (#145), and what makes a reused jobId a detectable
 * duplicate. It is not a result store (see the design doc §D1).
 */
export const TOMBSTONE_MS = 10 * 60 * 1000;

interface JobState {
  listeners: Set<JobListener>;
  complete?: JobCompleteEvent;
  backstop?: ReturnType<typeof setTimeout>;
}

/**
 * Build a channel. Constructed once by the composition root (`app.ts`) and
 * handed to `CaseGenerationService` and to every transport. It is an
 * instance, not a module singleton, so tests get one each.
 */
export function createJobEventChannel(): JobEventChannel {
  const jobs = new Map<string, JobState>();
  const tombstones = new Map<
    string,
    { complete: JobCompleteEvent; evict: ReturnType<typeof setTimeout> }
  >();
  const globalListeners = new Set<GlobalJobListener>();

  // A throwing adapter must not break the other adapters, or the node that
  // emitted the event (`publish` runs inside `traceNode`'s bus emit).
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
