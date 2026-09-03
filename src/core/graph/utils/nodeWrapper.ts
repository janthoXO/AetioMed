import { bus } from "@/core/graph/index.js";
import { getRequestContext } from "./context.js";
import type { Runtime } from "@langchain/langgraph";
import type { RequestContext } from "./context.js";

/**
 * Wraps a graph node function to automatically emit "Node Started" and
 * "Node Completed" bus events before and after the node's logic runs.
 *
 * Only wrap plain node functions — do not wrap compiled subgraphs
 * (CompiledStateGraph instances); those are not callable as functions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function traceNode<F extends (...args: any[]) => any>(
  name: string,
  fn: F,
  label?: string
): F {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (...args: any[]) => {
    const runtime = args[1] as Runtime<RequestContext> | undefined;
    const jobId = runtime?.context?.jobId ?? getRequestContext()?.jobId;

    bus.emit("Node Started", {
      node: name,
      label,
      jobId,
      timestamp: new Date().toISOString(),
    });

    const result = await fn(...args);

    bus.emit("Node Completed", {
      node: name,
      label,
      result,
      jobId,
      timestamp: new Date().toISOString(),
    });

    return result;
  }) as F;
}
