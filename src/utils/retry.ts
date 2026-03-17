/**
 * Retries a promise-returning function with exponential backoff and jitter.
 * @param fn
 * @param retries
 * @param baseDelayMs
 * @returns
 */
export function retry<T>(
  fn: (attempt: number) => Promise<T>,
  retries: number = 3,
  baseDelayMs: number = 1000,
  errorFn?: (error: any, attempt: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      fn(retries - n)
        .then(resolve)
        .catch((error) => {
          if (n > 0) {
            console.debug(
              `Retry attempt ${retries - n + 1} failed. Retrying...`,
              error.message
            );

            if (errorFn) {
              errorFn(error, retries - n + 1);
            }
            // Exponential backoff with jitter
            // Base delay: 1s, 2s, 4s...
            const exponentialBackoff = baseDelayMs * Math.pow(2, n - 1);
            // Jitter: +/- 20%
            const jitter = exponentialBackoff * 0.2 * (Math.random() * 2 - 1);
            const delay = exponentialBackoff + jitter;
            setTimeout(() => attempt(n - 1), delay);
          } else {
            reject(error);
          }
        });
    };
    attempt(retries);
  });
}
