/** Hands a slot back. Idempotent: a second call is a no-op. */
export type Release = () => void;

export interface Limiter {
  /** Wait for free slot, FIFO. Rejects `AbortError` if `signal` aborts while queued. */
  acquire(signal?: AbortSignal): Promise<Release>;
  readonly active: number;
  readonly waiting: number;
}

function abortError(): Error {
  const error = new Error("Aborted while waiting for a generation slot");
  error.name = "AbortError";
  return error;
}

/** FIFO counting semaphore. One instance bounds generations across all transports (`MAX_CONCURRENT_GENERATIONS`). */
export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`Limiter max must be a positive integer, got ${max}`);
  }

  let active = 0;
  const waiters: { grant: () => void }[] = [];

  function release(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next.grant();
      else active -= 1;
    };
  }

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (active < max) {
        active += 1;
        return Promise.resolve(release());
      }
      return new Promise<Release>((resolve, reject) => {
        const waiter = {
          // Slot passes straight to waiter: `active` never dips, no queue jumping.
          grant: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve(release());
          },
        };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
