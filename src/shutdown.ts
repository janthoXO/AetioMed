/**
 * One ordered, bounded shutdown, owned by the composition root (issue 18).
 *
 * Before this, `persistence/db.ts` and `transports/nats/index.ts` each
 * registered their own `SIGINT`/`SIGTERM` handlers. Node runs signal
 * listeners in registration order, and the DB's handler — registered
 * first, during graph construction — called `process.exit(0)`
 * *synchronously*, so the NATS handler registered afterwards was never
 * invoked at all: in-flight JetStream messages were neither acked nor
 * nacked, silently, until their ack-wait expired. `createApp()`
 * (`core/app.ts`) now builds one ordered list of closers as each transport
 * starts and returns a single `shutdown()`; this module is the only place
 * that turns a process signal into a call to it.
 */

/** One thing the composition root knows how to close, in the order it was registered. */
export interface Closer {
  readonly name: string;
  readonly close: () => Promise<void>;
}

/** Not an env var — a fixed ceiling so a hung close can never wedge the process open. */
const SHUTDOWN_DEADLINE_MS = 5000;

/**
 * Runs closers in the given order, continuing even if one rejects — a
 * failed NATS close must not leave the DB open, so every closer is
 * attempted regardless of earlier failures. If any of them rejected,
 * `runClosers` itself rejects after the last one has run, so the failure
 * still surfaces (via `installSignalHandlers`'s deadline/error path)
 * instead of being swallowed.
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
 * Registers `SIGINT`/`SIGTERM` handlers that run `shutdown()` once, bounded
 * by `SHUTDOWN_DEADLINE_MS`, then exit the process. `exit` is injectable
 * (defaults to the real `process.exit`) so tests can drive this without
 * spawning a process or sending a real signal — call the returned handler
 * directly instead. Returns the handler for that reason; production code
 * (`src/index.ts`) ignores the return value.
 */
export function installSignalHandlers(
  shutdown: () => Promise<void>,
  opts: { exit?: (code: number) => void } = {}
): (signal: NodeJS.Signals) => void {
  const exit = opts.exit ?? process.exit.bind(process);
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // One Ctrl+C is polite, two is an order: exit immediately without
      // waiting for the shutdown already in flight.
      console.error(`[shutdown] second ${signal}, exiting immediately`);
      exit(130);
      return;
    }
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, shutting down`);

    // Cleared on the success path below, never unref()'d: a clean shutdown
    // still exits as soon as it finishes, and a hung one always exits by
    // the deadline either way.
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
