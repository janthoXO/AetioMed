// Issue 15 §1.3 / §3 — trace payloads get a size cap, not a node's full
// output. Case outlines are large, and issue 11 made some node outputs
// carry `ContentPart[]` fields whose `value` is raw bytes. This module caps
// the *size* of a `TraceEvent`'s payload; the bytes-never-reach-a-trace
// projection itself (`sanitizeForTrace`) is shared with the OTel span's
// output-size attribute (`nodeWrapper.ts`) and lives in
// `core/graph/utils/traceSanitize.ts` so the two channels agree on what a
// node's output "is" once bytes are stripped out of it.
import { sanitizeForTrace } from "@/core/graph/utils/traceSanitize.js";
import type { TracePayload } from "./traceManager.js";

/**
 * Cap on the serialized (sanitized) trace payload, in UTF-8 bytes.
 * Deliberately independent of `MAX_CONTENT_PART_BYTES` (issue 11's ceiling
 * on one content part's *decoded* size, 5MB by default) — that constant
 * bounds what a client may upload/receive on the case wire; this one bounds
 * what an operator's trace stream carries per node execution, which is a
 * much smaller "is this useful to look at" budget, not a correctness limit.
 * Not exposed as an env var: the spec for this issue is explicit about not
 * inventing new home-grown configuration knobs alongside OTel's standard
 * ones, and a fixed cap is enough to keep a trace stream reasonable.
 */
export const MAX_TRACE_PAYLOAD_BYTES = 50_000;

/** How much of the oversized JSON to keep as a `preview`. */
const PREVIEW_CHARS = 500;

export { sanitizeForTrace };

/**
 * Build a `TracePayload` from a node's raw result: sanitize away any bytes,
 * then cap the serialized size. Over the cap, the payload is replaced with
 * `{ truncated: true, bytes, preview }` rather than truncated in place —
 * partial JSON is not useful to an operator and the marker is unambiguous.
 */
export function buildTracePayload(
  value: unknown,
  maxBytes: number = MAX_TRACE_PAYLOAD_BYTES
): TracePayload {
  const sanitized = sanitizeForTrace(value);

  let json: string;
  try {
    json = JSON.stringify(sanitized) ?? "null";
  } catch {
    // Unserializable (e.g. a circular structure) — treat as oversized so
    // the caller still gets a bounded, safe marker instead of a thrown error.
    json = String(sanitized);
  }

  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) {
    return { truncated: false, value: sanitized };
  }

  return { truncated: true, bytes, preview: json.slice(0, PREVIEW_CHARS) };
}
