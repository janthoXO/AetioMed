/**
 * Retries a promise-returning function with exponential backoff and jitter.
 * @param fn
 * @param retries
 * @param baseDelayMs
 * @returns
 */
export function retry<T>(
  fn: (attempt: number, error?: Error) => Promise<T>,
  retries: number = 3,
  baseDelayMs: number = 1000,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errorFn?: (error: Error, attempt: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const attempt = (remainingAttempts: number, error?: Error) => {
      fn(retries - remainingAttempts, error)
        .then(resolve)
        .catch((error) => {
          if (remainingAttempts < 1) {
            reject(error);
            return;
          }

          console.debug(
            `Retry attempt ${retries - remainingAttempts + 1} failed. Retrying...`,
            error.message
          );
          if (errorFn) {
            errorFn(error, retries - remainingAttempts + 1);
          }
          // Exponential backoff with jitter
          // Base delay: 1s, 2s, 4s...
          const exponentialBackoff =
            baseDelayMs * Math.pow(2, remainingAttempts - 1);
          // Jitter: +/- 20%
          const jitter = exponentialBackoff * 0.2 * (Math.random() * 2 - 1);
          const delay = exponentialBackoff + jitter;

          // Schedule the next attempt
          setTimeout(() => attempt(remainingAttempts - 1, error), delay);
        });
    };

    // initial function call
    attempt(retries);
  });
}
