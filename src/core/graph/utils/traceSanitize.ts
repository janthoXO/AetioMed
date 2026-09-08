// Shared by `tracing/tracePayload.ts` (the SSE trace channel's size-capped
// payload) and `nodeWrapper.ts` (the OTel span's output-size attribute) —
// both need "this node's result, with bytes projected to text" and must
// agree on what that means, so it lives here once rather than twice. Pure:
// only depends on `ContentPart`'s `textOf`, no env, no I/O — safe under
// `src/core/graph/`'s "no process.env" rule.
import { textOf, type ContentPart } from "@/core/graph/models/ContentPart.js";

function isContentPart(value: unknown): value is ContentPart {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "alt" in value &&
    "value" in value &&
    typeof (value as ContentPart).type === "string" &&
    typeof (value as ContentPart).alt === "string" &&
    (value as ContentPart).value instanceof Uint8Array
  );
}

function isContentPartArray(value: unknown): value is ContentPart[] {
  return Array.isArray(value) && value.length > 0 && value.every(isContentPart);
}

/**
 * Recursively replace anything byte-shaped with its text projection, never
 * bytes: `ContentPart[]` becomes `textOf(parts)`, exactly as prompts do
 * (issue 11 §4); a lone `ContentPart` becomes its `alt`; a bare
 * `Uint8Array` (there is no legitimate way for one to reach a node's return
 * value outside a `ContentPart`, but this is a safety net, not a trusted
 * invariant) becomes a size marker. Everything else is walked structurally
 * so a nested `chiefComplaint`/`anamnesis`/`procedures` field inside an
 * arbitrary node result is caught regardless of where it sits.
 */
export function sanitizeForTrace(value: unknown): unknown {
  if (isContentPartArray(value)) return textOf(value);
  if (isContentPart(value)) return value.alt;
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(sanitizeForTrace);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, sanitizeForTrace(v)])
    );
  }
  return value;
}
