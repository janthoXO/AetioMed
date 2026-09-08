import type { EventBus } from "@/core/event-bus.js";
import { getRequestContext } from "./context.js";
import type { Runtime } from "@langchain/langgraph";
import type { RequestContext } from "./context.js";

/**
 * Every label passed to {@link traceNode} — collected as `buildCaseGraph()`
 * (and friends) construct the graphs. Core no longer translates labels (see
 * `02graphs/caseGraph.ts` and `catalog/startupValidation.ts`'s doc
 * comments); this registry's job now is purely the labels catalogue's
 * **base key set** for startup validation — `validateCatalogsOrExit`
 * (`catalog/startupValidation.ts`) checks `labelTranslations.yml` against
 * exactly these keys, which is what first caught six stale and four missing
 * keys in that file. Deleting this registry would silently drop that
 * guarantee.
 */
const knownLabels = new Set<string>();

export function getKnownLabels(): string[] {
  return [...knownLabels];
}

/**
 * Builds `traceNode`, closed over the bus it emits "Node Started"/"Node
 * Completed" on. Called once per `GraphRuntime` at graph-assembly time.
 *
 * Wraps a graph node function to automatically emit "Node Started" and
 * "Node Completed" bus events before and after the node's logic runs. Trace
 * labels are always emitted in English — a transport that wants a localized
 * label (see `tracing/index.ts`) looks up the translation itself and falls
 * back to English.
 *
 * Only wrap plain node functions — do not wrap compiled subgraphs
 * (CompiledStateGraph instances); those are not callable as functions.
 */
export function createTraceNode(bus: EventBus) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function traceNode<F extends (...args: any[]) => any>(
    name: string,
    fn: F,
    label?: string
  ): F {
    if (label) knownLabels.add(label);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (async (...args: any[]) => {
      const runtime = args[1] as Runtime<RequestContext> | undefined;
      const context = runtime?.context ?? getRequestContext();
      const jobId = context?.jobId;

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
  };
}
