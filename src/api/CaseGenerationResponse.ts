import { z } from "zod";
import {
  CasePieceWireSchema,
  CaseWireSchema,
  encodeCase,
  encodePiece,
} from "./contentWire.js";
import { ErrorResponseSchema } from "./ErrorResponse.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import type { CasePiece } from "@/core/regenerate.js";

// Wire shape (`CaseWireSchema`), not domain `CaseSchema`: `ContentPart[]` value
// is JSON string (UTF-8 for text/*, base64 otherwise), not raw `Uint8Array`.
export const CaseGenerationResponseSchema = z.union([
  CaseWireSchema.extend({
    jobId: z.string().optional(),
    status: z.literal("done"),
    // Language generation ran in (echoes the request, default en).
    // Echoed so client can retry with explicit `language`.
    language: z.string(),
    context: z
      .string()
      .describe(
        "Opaque generation context (#272): store it with this case, send it back unchanged on the next call about this case."
      ),
    pieces: z
      .array(CasePieceWireSchema)
      .optional()
      .describe(
        "A regenerate call's result instead of the case fields: each piece replaces the value at its `path` in the case."
      ),
  }),
  // NATS `cases.result.<jobId>` failures carry the jobId; REST errors don't.
  ErrorResponseSchema.extend({ jobId: z.string().optional() }),
]);

export type CaseGenerationResponse = z.infer<
  typeof CaseGenerationResponseSchema
>;

/** Case fields, or a regenerate call's pieces, wire-encoded. */
export function encodeDone(
  result: { case?: Case | undefined; pieces?: CasePiece[] | undefined },
  maxBytes: number
) {
  return result.pieces
    ? {
        status: "done" as const,
        pieces: result.pieces.map((p) => encodePiece(p, maxBytes)),
      }
    : { status: "done" as const, ...encodeCase(result.case!, maxBytes) };
}
