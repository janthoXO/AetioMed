import type { GraphRuntime } from "@/core/graph/runtime.js";

/**
 * Log-then-rethrow around a bare gateway promise. Adapters call the aigateway
 * directly, skipping `Tool` input validation; inputs are statically typed.
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
