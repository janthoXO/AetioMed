// Shared by `observability/tracePayload.ts` and `nodeWrapper.ts`: node result
// with content parts reduced to MIME and size. Pure: no env, no I/O.
import type { ContentPart } from "@/core/graph/shared/domain/ContentPart.js";

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

/**
 * Recursively replace byte-shaped values: every `ContentPart` -> `{ type, bytes }`
 * (no `alt`: planner nodes and `translate_rest` already log it; no text, no raw
 * bytes; rendered content is checked in the API response); bare `Uint8Array`
 * -> size marker (safety net). Everything else walked structurally, so nested
 * content fields are caught.
 */
export function sanitizeForTrace(value: unknown): unknown {
  if (isContentPart(value))
    return { type: value.type, bytes: value.value.byteLength };
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(sanitizeForTrace);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, sanitizeForTrace(v)])
    );
  }
  return value;
}
