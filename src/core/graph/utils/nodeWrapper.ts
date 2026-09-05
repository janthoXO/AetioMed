import type { EventBus } from "@/core/event-bus.js";
import { getRequestContext } from "./context.js";
import type { Runtime } from "@langchain/langgraph";
import type { RequestContext } from "./context.js";
import { sanitizeForTrace } from "./traceSanitize.js";

/**
 * The OTel operator channel's port (issue 15 §5/§1.1) — core (this file)
 * owns the interface, exactly the `registerJobHook` pattern `utils/context.ts`
 * already uses for the `TraceBus` hook: core never imports
 * `@opentelemetry/*` or reads `process.env` (both are off-limits under
 * `src/core/graph/` — see `CLAUDE.md`), so the concrete adapter
 * (`tracing/otel.ts`) lives outside core and is constructed once by the
 * composition root (`app.ts`), independent of `FEATURES=TRACING` — see
 * `tracing/index.ts`'s doc comment on `wireTracing` for why the two
 * channels are deliberately separate.
 */
export interface NodeSpan {
  /** The node's (sanitized, bytes-projected-to-text) output size. */
  setOutputBytes(bytes: number): void;
  /**
   * Model/provider used by this node's request, when known — only
   * available today via per-request `llmConfig` (the `ALLOW_LLMS` path);
   * the deployer's static default config is not currently threaded to this
   * seam. Token counts are not recorded anywhere in this codebase as of
   * issue 15 — "where available" is honestly "never" right now, so no
   * attribute is fabricated for them.
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
  setOutputBytes() {},
  setLlm() {},
  fail() {},
  end() {},
};

/** The default when no `NodeTracer` is supplied (every test, `exportGraphs.ts`). */
export const noopNodeTracer: NodeTracer = {
  startSpan: () => noopSpan,
};

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
 * `nodeId -> labelKey`, populated the same way `knownLabels` is — as
 * `buildCaseGraph()` constructs every graph variant. This is what
 * `GET /api/graph` (issue 15 §4, `tracing/structure/`) joins against the
 * compiled topology's node ids to attach each node's English label key,
 * without the structure endpoint reaching back into every subgraph module
 * to ask. `knownLabels` stays a `Set<string>` (startup validation only cares
 * about the key set); this is the id-keyed view the structure endpoint
 * needs on top of it.
 */
const nodeLabels = new Map<string, string>();

export function getNodeLabels(): Record<string, string> {
  return Object.fromEntries(nodeLabels);
}

/**
 * A `traceNode` function as handed to a graph-assembly module, plus the
 * `.scope()` it carries — see `createTraceNode`'s doc comment for why
 * scoping exists at all.
 */
export interface TraceNodeFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  <F extends (...args: any[]) => any>(name: string, fn: F, label?: string): F;
  /**
   * Return a new `TraceNodeFn` whose emitted node ids are prefixed with
   * `name:` (and, recursively, whatever this one's own prefix already was).
   * Call this exactly where a compiled subgraph is about to be mounted
   * under `name` via `.addNode(name, someBuiltSubgraph)`, passing the
   * result into that subgraph's builder instead of the unscoped
   * `traceNode` — see `createTraceNode`'s doc comment for why the prefix
   * must match LangGraph's own mount name exactly.
   */
  scope(name: string): TraceNodeFn;
}

/**
 * Builds `traceNode`, closed over the bus it emits "Node Started"/"Node
 * Completed"/"Node Failed" on. Called once per `GraphRuntime` at
 * graph-assembly time.
 *
 * Wraps a graph node function to automatically emit "Node Started" and
 * "Node Completed" (or, on failure, "Node Failed") bus events around the
 * node's logic. Trace labels are always emitted in English — a transport
 * that wants a localized label (see `tracing/index.ts`) looks up the
 * translation itself and falls back to English.
 *
 * **Issue 15 §2 defect fix.** This used to have no `try`/`catch`: a
 * throwing node emitted "Node Started" and never anything terminal, so any
 * consumer pairing started/completed events (a progress UI, a span, a
 * per-job resource waiting for a terminal state) stayed unbalanced forever.
 * Now every path — success or failure — emits exactly one terminal event,
 * and the error is rethrown, never swallowed: `traceNode` is instrumentation
 * wrapped around the node, not error handling for it, so callers see
 * exactly the failure they would have without this wrapper, just with an
 * event and (issue 15 §5) an errored span recorded on the way out.
 *
 * **Issue 15 §3/§4 — why `.scope()` exists.** The spec for this issue
 * assumed a node's bare name (`traceNode`'s first argument, e.g.
 * `"generate_content"`) already *is* "the LangGraph node id" the structure
 * endpoint (`GET /api/graph`) would report. Verified against a real
 * compiled graph, that is false for any node nested inside a subgraph:
 * `getGraphAsync({ xray: true })` (the same call `exportGraphs.ts` uses)
 * reports nested nodes under a colon-joined path — e.g.
 * `"generation_phase:presentation_phase:chief_complaint_generate:generate_content"`
 * — not the bare `"generate_content"`. Two different subgraphs
 * (`chiefComplaintGraph.ts` and `anamnesisGraph.ts`) both have a node
 * literally named `generate_content`, so the bare name is not even unique
 * across the compiled graph — reporting it unqualified from the structure
 * endpoint would collapse two distinct nodes onto one id and corrupt the
 * rendered graph's edges, not just the trace/structure correlation.
 *
 * The fix threads the same qualification LangGraph itself uses: every
 * module that mounts a compiled subgraph under a name (`.addNode(name,
 * builtSubgraph)`) calls `traceNode.scope(name)` and passes *that* into the
 * subgraph's builder instead of the unscoped `traceNode` — see
 * `caseGraph.ts`'s `assembleCaseGraph`, `02case-generation/index.ts`'s
 * `buildCaseGenerationGraph`, and `02presentation/generation/index.ts`'s
 * `buildFieldGenerationGraph` for the five call sites that do this. Every
 * other `traceNode(...)` call site is unchanged: it already receives a
 * `traceNode` scoped correctly by its caller and just uses it directly.
 *
 * **Issue 15 §5 — one OTel span per node, from this same seam.** `tracer`
 * defaults to `noopNodeTracer`, so every existing call site
 * (`exportGraphs.ts`, every test) is unaffected; only `buildCaseGraph`
 * (`02graphs/caseGraph.ts`) is given a real one, sourced from the
 * composition root. The span brackets exactly the same region the bus
 * events do, ends with an error status on the same `catch` that emits
 * "Node Failed", and is otherwise inert when `tracer` is the no-op (no
 * attribute call does anything observable).
 *
 * Only wrap plain node functions — do not wrap compiled subgraphs
 * (CompiledStateGraph instances); those are not callable as functions.
 */
export function createTraceNode(
  bus: EventBus,
  tracer: NodeTracer = noopNodeTracer
): TraceNodeFn {
  return buildTraceNode(bus, tracer, undefined);
}

/** Best-effort output size for the OTel span attribute — never throws. */
function outputByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(
      JSON.stringify(sanitizeForTrace(value)) ?? "null",
      "utf8"
    );
  } catch {
    return 0;
  }
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

      bus.emit("Node Started", {
        node: nodeId,
        label,
        jobId,
        timestamp: new Date().toISOString(),
      });

      const span = tracer.startSpan(nodeId, { jobId });
      if (context?.llmConfig?.provider && context?.llmConfig?.model) {
        span.setLlm(context.llmConfig.provider, context.llmConfig.model);
      }

      try {
        const result = await fn(...args);

        span.setOutputBytes(outputByteSize(result));
        span.end();

        bus.emit("Node Completed", {
          node: nodeId,
          label,
          result,
          jobId,
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
