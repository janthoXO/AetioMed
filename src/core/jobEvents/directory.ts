// Watch/cancel a job by id, wherever it runs. Label stream and DELETE go
// through this port: with several replicas the in-process channel would
// wrongly answer "unknown". `app.ts` picks local or NATS
// (`transports/nats/jobDirectory.ts`) implementation.
import type { JobCompleteEvent, JobEventChannel } from "./channel.js";
import type { LabelEvent } from "./labels.js";

/**
 * What an observer sees: labels, then the terminal marker — never the case,
 * never the plan.
 */
export type WatchedEvent =
  | { type: "label"; data: LabelEvent }
  | { type: "complete"; data: JobCompleteEvent };

/**
 * Handed back *before* events are delivered: caller decides response, then
 * `listen` replays buffered events and goes live until `complete`. Returns
 * stop function.
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
   * Watch `jobId`. Subscribes before answering; no event lost. Terminal job
   * returns its `complete` event; unknown job `unknown`. Rejects only when no
   * answer obtainable (e.g. timeout); not the same as `unknown`.
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
 * Single-process directory: job must run in this process. Only option with
 * `NATS` disabled (single replica).
 */
export function createLocalJobDirectory(
  channel: JobEventChannel,
  cancel: (jobId: string) => boolean
): JobDirectory {
  return {
    async watch(jobId) {
      // Buffer exists before subscription so events published during
      // `subscribe` have somewhere to go. Stop bound once subscribed.
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
