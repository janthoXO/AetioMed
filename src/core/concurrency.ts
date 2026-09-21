/** Hands a slot back. Idempotent: a second call is a no-op. */
export type Release = () => void;

export interface AcquireOptions {
  /**
   * `"high"` for resumed work (a job continuing after human review, or
   * resumed after a restart) — it is granted a slot before any `"normal"`
   * waiter, however long that waiter has been queued (#159). Defaults to
   * `"normal"`.
   */
  priority?: "high" | "normal";
}

export interface Limiter {
  /**
   * Wait for a free slot. Grants go to the oldest `"high"`-priority waiter
   * first, then FIFO within each priority lane (#159) — so a job resuming
   * after a human review or a restart does not lose its slot to a newer
   * request that happened to queue first. Rejects with an `AbortError` if
   * `signal` aborts while waiting — a job cancelled while queued never
   * takes a slot.
   */
  acquire(signal?: AbortSignal, opts?: AcquireOptions): Promise<Release>;
  readonly active: number;
  readonly waiting: number;
  /** Waiters currently in the high-priority lane (a subset of `waiting`). */
  readonly waitingHigh: number;
}

function abortError(): Error {
  const error = new Error("Aborted while waiting for a generation slot");
  error.name = "AbortError";
  return error;
}

/**
 * A FIFO counting semaphore. One instance bounds generations across every
 * transport (`MAX_CONCURRENT_GENERATIONS`, #142), so throughput does not
 * depend on which door a request came in through.
 *
 * Two priority lanes (#159): a freed slot goes to the oldest `"high"`
 * waiter if any, else the oldest `"normal"` waiter — FIFO within each lane.
 * This lets a job resumed after a human review or a restart jump ahead of
 * new requests already queued. It can't starve new work indefinitely only
 * because every high-priority waiter belongs to an already-admitted job and
 * is bounded by the review-round limit — a property of the callers, not of
 * this limiter, which has no notion of how many high waiters are coming.
 */
export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`Limiter max must be a positive integer, got ${max}`);
  }

  let active = 0;
  const high: { grant: () => void }[] = [];
  const normal: { grant: () => void }[] = [];

  function release(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = high.shift() ?? normal.shift();
      if (next) next.grant();
      else active -= 1;
    };
  }

  return {
    acquire(signal, opts) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (active < max) {
        active += 1;
        return Promise.resolve(release());
      }
      const lane = opts?.priority === "high" ? high : normal;
      return new Promise<Release>((resolve, reject) => {
        const waiter = {
          // The slot passes straight from the releaser to this waiter, so
          // `active` never dips and nobody can jump the queue in between.
          grant: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve(release());
          },
        };
        const onAbort = () => {
          const index = lane.indexOf(waiter);
          if (index !== -1) lane.splice(index, 1);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        lane.push(waiter);
      });
    },
    get active() {
      return active;
    },
    get waiting() {
      return high.length + normal.length;
    },
    get waitingHigh() {
      return high.length;
    },
  };
}
