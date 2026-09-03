import { bus } from "@/core/graph/index.js";
import { getRequestContext } from "./context.js";
import { getLabelTranslation } from "@/core/graph/03repo/labels.repo.js";
import type { Runtime } from "@langchain/langgraph";
import type { RequestContext } from "./context.js";

/**
 * Every label passed to {@link traceNode} — collected at module-load time as the
 * graphs are constructed. The case generator warms the label-translation cache
 * for the requested language using this catalogue before generation starts.
 */
const knownLabels = new Set<string>();

export function getKnownLabels(): string[] {
  return [...knownLabels];
}

/**
 * Resolve a label into the request's language using the (pre-warmed) label
 * cache. Synchronous on purpose — runs on the trace hot path. Falls back to the
 * English label when no translation is cached.
 */
function resolveLabel(
  label: string | undefined,
  language: RequestContext["language"]
): string | undefined {
  if (!label || !language || language === "English") return label;
  return getLabelTranslation(label, language) ?? label;
}

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
  if (label) knownLabels.add(label);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (...args: any[]) => {
    const runtime = args[1] as Runtime<RequestContext> | undefined;
    const context = runtime?.context ?? getRequestContext();
    const jobId = context?.jobId;
    const localizedLabel = resolveLabel(label, context?.language);

    bus.emit("Node Started", {
      node: name,
      label: localizedLabel,
      jobId,
      timestamp: new Date().toISOString(),
    });

    const result = await fn(...args);

    bus.emit("Node Completed", {
      node: name,
      label: localizedLabel,
      result,
      jobId,
      timestamp: new Date().toISOString(),
    });

    return result;
  }) as F;
}
