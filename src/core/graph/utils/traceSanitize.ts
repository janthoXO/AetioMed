// Shared by `observability/tracePayload.ts` and `nodeWrapper.ts`: node result
// with bytes projected to text. Pure: no env, no I/O.
import {
  textOf,
  textOfPart,
  type ContentPart,
} from "@/core/graph/models/ContentPart.js";

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
 * Recursively replace byte-shaped values with text projection: `ContentPart[]`
 * -> `textOf(parts)`; lone `ContentPart` -> `textOfPart` (what a prompt would
 * see, not the planner's label); bare `Uint8Array` -> size marker (safety
 * net). Everything else walked structurally, so nested content fields are caught.
 */
export function sanitizeForTrace(value: unknown): unknown {
  if (isContentPartArray(value)) return textOf(value);
  if (isContentPart(value)) return textOfPart(value);
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(sanitizeForTrace);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, sanitizeForTrace(v)])
    );
  }
  return value;
}
