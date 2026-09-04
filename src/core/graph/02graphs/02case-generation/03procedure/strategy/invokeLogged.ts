import type { GraphRuntime } from "@/core/graph/runtime.js";

/**
 * Log-then-rethrow wrapper around a gateway call — the strategy-directory
 * equivalent of `03procedure/index.ts`'s `invokeLogged`, but around a bare
 * promise rather than a `Tool.invoke()`. The adapters call the aigateway
 * functions directly instead of going through `Tool` wrappers (see issue
 * 07's spec §3: six of the eight procedure tools are deleted because they
 * only ever wrapped a single strategy-specific gateway call). That trades
 * away the tools' input Zod validation, which is fine here: the adapters are
 * statically typed and their inputs are constructed in exactly one place
 * each.
 */
export async function invokeLogged<T>(
  runtime: GraphRuntime,
  promise: Promise<T>,
  errorLabel: string
): Promise<T> {
  return promise.catch((error) => {
    runtime.log.error(`[ProcedureGraph] ${errorLabel}: ${error}`);
    throw error;
  });
}
