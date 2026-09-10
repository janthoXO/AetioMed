// Watching and cancelling a job *by id*, wherever it runs (#145). The label
// stream (`GET /api/cases/:jobId/labels`) and `DELETE /api/cases/:jobId` go
// through this port rather than the channel or the service directly: with
// one process the answer is local, but with several replicas the job may be
// running on another one, and the in-process channel would answer "unknown"
// — a silent wrong answer. The composition root (`app.ts`) picks the
// implementation: the local one below, or the NATS one
// (`transports/nats/jobDirectory.ts`) when NATS is enabled. So REST depends
// on NATS only through composition, and NATS never depends on REST.
import type { JobCompleteEvent, JobEventChannel } from "./channel.js";
import type { LabelEvent } from "./labels.js";

/** What an observer sees: labels, then the terminal marker — never the case. */
export type WatchedEvent =
  | { type: "label"; data: LabelEvent }
  | { type: "complete"; data: JobCompleteEvent };

/**
 * An active job is handed back *before* any of its events are delivered:
 * the caller decides its response (a 404 vs. an SSE stream) first, then
 * calls `listen`, which replays whatever arrived in between and then
 * delivers live until the job's `complete`. Returns a stop function.
 */
export type ActiveWatch = {
  state: "active";
  listen(onEvent: (event: WatchedEvent) => void): () => void;
};

export type WatchResult =
  | ActiveWatch
  | { state: "terminal"; complete: JobCompleteEvent }
  | { state: "unknown" };

export type CancelResult = "cancelled" | "finished" | "unknown";

export interface JobDirectory {
  /**
   * Start watching `jobId`. Subscribes before it answers, so no event is
   * lost between learning the state and listening. A terminal job answers
   * with its `complete` event instead of a subscription; a job nobody knows
   * answers `unknown`. Rejects only when the answer could not be obtained
   * (e.g. the backbone timed out) — that is not the same as `unknown`.
   */
  watch(jobId: string): Promise<WatchResult>;
  /** Cancel `jobId` wherever it runs. Rejects when no answer could be obtained. */
  cancel(jobId: string): Promise<CancelResult>;
}

/**
 * Buffer events until a listener attaches, then replay and go live. Shared
 * by both directory implementations.
 */
export function createBufferedWatch(stop: () => void): {
  push(event: WatchedEvent): void;
  watch: ActiveWatch;
} {
  let buffer: WatchedEvent[] | undefined = [];
  let listener: ((event: WatchedEvent) => void) | undefined;
  return {
    push(event) {
      if (listener) listener(event);
      else buffer?.push(event);
    },
    watch: {
      state: "active",
      listen(onEvent) {
        const pending = buffer ?? [];
        buffer = undefined;
        listener = onEvent;
        for (const event of pending) onEvent(event);
        return stop;
      },
    },
  };
}

/**
 * The single-process directory: the job must be running in this process.
 * With `NATS` disabled this is the only option, and a single replica is a
 * documented deployment constraint (design doc §D5).
 */
export function createLocalJobDirectory(
  channel: JobEventChannel,
  cancel: (jobId: string) => boolean
): JobDirectory {
  return {
    async watch(jobId) {
      // The buffer exists before the subscription, so an event published
      // during `subscribe` itself has somewhere to go. Its stop function is
      // bound once the subscription exists.
      let unsubscribe = () => {};
      const buffered = createBufferedWatch(() => unsubscribe());
      const subscription = channel.subscribe(jobId, (event) => {
        if (event.type === "label" || event.type === "complete") {
          buffered.push(event);
        }
      });
      if (subscription.state !== "active") return subscription;
      unsubscribe = subscription.unsubscribe;
      return buffered.watch;
    },

    async cancel(jobId) {
      if (cancel(jobId)) return "cancelled";
      return channel.state(jobId) === "unknown" ? "unknown" : "finished";
    },
  };
}
