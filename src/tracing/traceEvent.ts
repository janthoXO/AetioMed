/**
 * Trace payloads get a size cap, not the node's full output (issue 15 §1.3):
 * case outlines are large and some node outputs are binary (issue 11).
 * Never the node's raw output when it exceeds this — `bytes`/`preview`
 * instead. See `tracePayload.ts`'s `buildTracePayload`, the only producer of
 * this type.
 */
export type TracePayload =
  | { truncated: false; value: unknown }
  | { truncated: true; bytes: number; preview: string };

/**
 * The operator-facing trace channel's event shape (issue 15 §3) —
 * node-bound and typed, replacing the old `{jobId, type, timestamp,
 * payload: any}` with its eslint-suppressed `any`. Every event carries the
 * **LangGraph node id** as `nodeId`, the same string `GET /api/graph`
 * (`tracing/structure/`) reports for that node, so a client can key one
 * against the other. `labelKey` is always the English label key (issue 15
 * §1.2) — traces are English, always; a transport wanting a localized
 * string uses the separate `label` event (`core/jobEvents/labels.ts`) instead.
 */
export type TraceEvent =
  | {
      kind: "node_started";
      jobId: string;
      nodeId: string;
      labelKey: string;
      timestamp: string;
    }
  | {
      kind: "node_completed";
      jobId: string;
      nodeId: string;
      labelKey: string;
      timestamp: string;
      output: TracePayload;
    }
  | {
      kind: "node_failed";
      jobId: string;
      nodeId: string;
      labelKey: string;
      timestamp: string;
      error: string;
    }
  | {
      kind: "generation_completed";
      jobId: string;
      timestamp: string;
      case: unknown;
    }
  | {
      kind: "generation_failed";
      jobId: string;
      timestamp: string;
      error: string;
    }
  | {
      kind: "generation_cancelled";
      jobId: string;
      timestamp: string;
    };
