import { getRequestContext } from "./context.js";

export function retry<T>(
  fn: (attempt: number, error?: Error) => Promise<T>,
  retries: number = 3,
  baseDelayMs: number = 1000,
  errorFn?: (error: Error, attempt: number) => void
): Promise<T> {
  const signal = getRequestContext()?.signal;

  return new Promise((resolve, reject) => {
    const attempt = (remainingAttempts: number, error?: Error) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }

      fn(retries - remainingAttempts, error)
        .then(resolve)
        .catch((err: Error) => {
          // AbortErrors are never retried — propagate immediately
          if (err?.name === "AbortError") {
            reject(err);
            return;
          }

          if (remainingAttempts < 1) {
            reject(err);
            return;
          }

          console.debug(
            `Retry attempt ${retries - remainingAttempts + 1} failed. Retrying...`,
            err.message
          );
          if (errorFn) {
            errorFn(err, retries - remainingAttempts + 1);
          }

          const exponentialBackoff =
            baseDelayMs * Math.pow(2, remainingAttempts - 1);
          const jitter = exponentialBackoff * 0.2 * (Math.random() * 2 - 1);
          const delay = exponentialBackoff + jitter;

          const timeoutId = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            attempt(remainingAttempts - 1, err);
          }, delay);

          const onAbort = () => {
            clearTimeout(timeoutId);
            reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
          };

          signal?.addEventListener("abort", onAbort, { once: true });
        });
    };

    attempt(retries);
  });
}
