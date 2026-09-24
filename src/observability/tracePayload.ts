// Node output gets a size cap. Outlines are large and `ContentPart[]` values are raw
// bytes. Bytes projection (`sanitizeForTrace`) is shared with `nodeWrapper.ts`,
// lives in `core/graph/utils/traceSanitize.ts`.
import { sanitizeForTrace } from "@/core/graph/utils/traceSanitize.js";

/** Node output, capped: past cap only `bytes`/`preview`. {@link buildTracePayload} is only producer. */
export type TracePayload =
  | { truncated: false; value: unknown }
  | { truncated: true; bytes: number; preview: string };

/**
 * Cap on serialized (sanitized) trace payload, UTF-8 bytes. Independent of
 * `MAX_CONTENT_PART_BYTES`: bounds operator trace size, not a correctness limit.
 * Not an env var.
 */
export const MAX_TRACE_PAYLOAD_BYTES = 50_000;

/** How much of the oversized JSON to keep as a `preview`. */
const PREVIEW_CHARS = 500;

export { sanitizeForTrace };

/**
 * Build `TracePayload` from raw result: sanitize bytes away, cap serialized size.
 * Over cap: `{ truncated: true, bytes, preview }` marker, not partial JSON.
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
    // Unserializable (e.g. circular): treat as oversized, return bounded marker.
    json = String(sanitized);
  }

  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) {
    return { truncated: false, value: sanitized };
  }

  return { truncated: true, bytes, preview: json.slice(0, PREVIEW_CHARS) };
}
