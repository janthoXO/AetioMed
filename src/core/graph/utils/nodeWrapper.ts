import type { EventBus } from "@/core/event-bus.js";
import { getRequestContext } from "./context.js";
import type { Runtime } from "@langchain/langgraph";
import type { RequestContext } from "./context.js";
import { sanitizeForTrace } from "./traceSanitize.js";

/**
 * OTel operator channel port. Core owns interface; adapter
 * (`observability/otel.ts`, built in `app.ts`) implements it. Core never
 * imports `@opentelemetry/*` or reads `process.env`. Separate from labels
 * (`core/jobEvents/labels.ts`), which carry no node output.
 */
export interface NodeSpan {
  /**
   * Node output, already sanitized (`sanitizeForTrace`). Adapter records its
   * **size** as span attribute, value as correlated log record, never as
   * span attribute.
   */
  setOutput(output: unknown): void;
  /**
   * Model/provider for this request. Known only from per-request `llmConfig`
   * (`ALLOW_LLMS`); static default not threaded here. No token counts.
   */
  setLlm(provider: string, model: string): void;
  /** Record the node's failure and mark the span errored. */
  fail(message: string): void;
  end(): void;
}

export interface NodeTracer {
  startSpan(nodeId: string, attrs: { jobId?: string | undefined }): NodeSpan;
}

const noopSpan: NodeSpan = {
  setOutput() {},
  setLlm() {},
  fail() {},
  end() {},
};

/** The default when no `NodeTracer` is supplied (every test, `exportGraphs.ts`). */
export const noopNodeTracer: NodeTracer = {
  startSpan: () => noopSpan,
};

/**
 * Every label passed to {@link traceNode}, collected during graph
 * construction. Labels catalogue **base key set**: `validateCatalogsOrExit`
 * checks `labelTranslations.yml` against it.
 */
const knownLabels = new Set<string>();

export function getKnownLabels(): string[] {
  return [...knownLabels];
}

/** `nodeId -> labelKey`, populated like `knownLabels`. `structure.ts` joins it to topology node ids. */
const nodeLabels = new Map<string, string>();

export function getNodeLabels(): Record<string, string> {
  return Object.fromEntries(nodeLabels);
}

/** `traceNode` plus `.scope()`; see `createTraceNode`. */
export interface TraceNodeFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  <F extends (...args: any[]) => any>(name: string, fn: F, label?: string): F;
  /**
   * New `TraceNodeFn` whose node ids get prefix `name:` (nested with any
   * existing prefix). Call where a subgraph is mounted via
   * `.addNode(name, subgraph)`; prefix must match LangGraph's mount name.
   */
  scope(name: string): TraceNodeFn;
}

/**
 * Builds `traceNode`, closed over `bus`. Wraps a node function to emit "Node
 * Started" then exactly one of "Node Completed"/"Node Failed"; errors are
 * rethrown, never swallowed. Labels emitted in English; `wireLabels`
 * localizes per job.
 *
 * `.scope()`: LangGraph reports nested nodes by colon-joined path (e.g.
 * `generation_phase:presentation_phase:chief_complaint_generate:generate_content`),
 * and bare names repeat across subgraphs. Every module mounting a compiled
 * subgraph via `.addNode(name, subgraph)` must pass `traceNode.scope(name)`
 * into that subgraph's builder so ids match.
 *
 * One OTel span per node brackets the same region as the bus events and
 * fails in the same `catch`. `tracer` defaults to `noopNodeTracer`.
 *
 * Wrap plain node functions only, not compiled subgraphs.
 */
export function createTraceNode(
  bus: EventBus,
  tracer: NodeTracer = noopNodeTracer
): TraceNodeFn {
  return buildTraceNode(bus, tracer, undefined);
}

function buildTraceNode(
  bus: EventBus,
  tracer: NodeTracer,
  pathPrefix: string | undefined
): TraceNodeFn {
  function qualify(name: string): string {
    return pathPrefix ? `${pathPrefix}:${name}` : name;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function traceNode<F extends (...args: any[]) => any>(
    name: string,
    fn: F,
    label?: string
  ): F {
    const nodeId = qualify(name);

    if (label) {
      knownLabels.add(label);
      nodeLabels.set(nodeId, label);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (async (...args: any[]) => {
      const runtime = args[1] as Runtime<RequestContext> | undefined;
      const context = runtime?.context ?? getRequestContext();
      const jobId = context?.jobId;
      // From ALS: `language` is absent from `RequestContextSchema`. Rides on
      // the event so the label channel can localize.
      const language = getRequestContext()?.language;

      bus.emit("Node Started", {
        node: nodeId,
        label,
        language,
        jobId,
        timestamp: new Date().toISOString(),
      });

      const span = tracer.startSpan(nodeId, { jobId });
      if (context?.llmConfig?.provider && context?.llmConfig?.model) {
        span.setLlm(context.llmConfig.provider, context.llmConfig.model);
      }

      try {
        const result = await fn(...args);

        span.setOutput(sanitizeForTrace(result));
        span.end();

        bus.emit("Node Completed", {
          node: nodeId,
          label,
          result,
          jobId,
          language,
          timestamp: new Date().toISOString(),
        });

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        span.fail(message);
        span.end();

        bus.emit("Node Failed", {
          node: nodeId,
          label,
          error: message,
          jobId,
          language,
          timestamp: new Date().toISOString(),
        });

        throw error;
      }
    }) as F;
  }

  traceNode.scope = (name: string): TraceNodeFn =>
    buildTraceNode(bus, tracer, qualify(name));

  return traceNode;
}
