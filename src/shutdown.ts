/**
 * One ordered, bounded shutdown owned by composition root (`core/app.ts`).
 * Only place turning a process signal into a `shutdown()` call; nothing else
 * registers signal handlers (a sync `process.exit` in one would skip the rest).
 */

/** One closable thing, in registration order. */
export interface Closer {
  readonly name: string;
  readonly close: () => Promise<void>;
}

/** Fixed ceiling so hung close cannot wedge process. Not env var. */
const SHUTDOWN_DEADLINE_MS = 5000;

/**
 * Runs closers in order, continuing past rejections (failed NATS close must not
 * leave DB open). Rejects after last one if any failed.
 */
export async function runClosers(closers: readonly Closer[]): Promise<void> {
  const failed: string[] = [];
  for (const { name, close } of closers) {
    console.log(`[shutdown] closing ${name}`);
    try {
      await close();
      console.log(`[shutdown] closed ${name}`);
    } catch (error) {
      console.error(`[shutdown] ${name} failed to close:`, error);
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    throw new Error(`shutdown: failed to close ${failed.join(", ")}`);
  }
}

/**
 * Registers `SIGINT`/`SIGTERM` handlers running `shutdown()` once, bounded by
 * `SHUTDOWN_DEADLINE_MS`, then exit. `exit` injectable; returns handler so tests
 * call it directly.
 */
export function installSignalHandlers(
  shutdown: () => Promise<void>,
  opts: { exit?: (code: number) => void } = {}
): (signal: NodeJS.Signals) => void {
  const exit = opts.exit ?? process.exit.bind(process);
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // Second signal: exit immediately, don't wait for shutdown in flight.
      console.error(`[shutdown] second ${signal}, exiting immediately`);
      exit(130);
      return;
    }
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, shutting down`);

    // Cleared on success, never unref()'d: exits as soon as done, or by deadline.
    const timeout = setTimeout(() => {
      console.error(
        `[shutdown] deadline of ${SHUTDOWN_DEADLINE_MS}ms exceeded — see ` +
          `the last "[shutdown] closing …" line above for the step still ` +
          `in flight. Forcing exit.`
      );
      exit(1);
    }, SHUTDOWN_DEADLINE_MS);

    shutdown()
      .then(() => {
        clearTimeout(timeout);
        exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        console.error("[shutdown] shutdown() failed:", error);
        exit(1);
      });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return handleSignal;
}
