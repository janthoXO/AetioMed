// Wire encoding for `ContentPart[]`. Both transports encode `Case` through
// `encodeCase`; raw `Uint8Array` would JSON-stringify to `{"0":102,…}`.
// text/* -> UTF-8 string verbatim; else base64.
// `alt` always emitted and read back: independent of `value`, can differ. Lossless, order-preserving.
import { z } from "zod";
import {
  encodeText,
  type ContentPart,
} from "@/core/graph/models/ContentPart.js";
import { PatientSchema } from "@/core/graph/models/Patient.js";
import { ProcedureRelevanceSchema } from "@/core/graph/models/Procedure.js";
import { CaseSchema, type Case } from "@/core/graph/models/Case.js";

function isTextMime(type: string): boolean {
  return type.startsWith("text/");
}

export class ContentPartTooLargeError extends Error {
  constructor(field: string, sizeBytes: number, maxBytes: number) {
    super(
      `Content part in field "${field}" is ${sizeBytes} bytes, exceeding the ` +
        `${maxBytes}-byte limit (set via MAX_CONTENT_PART_BYTES).`
    );
    this.name = "ContentPartTooLargeError";
  }
}

/** One `ContentPart` on the wire. `alt` required: not derivable from `value`. */
export const ContentPartWireSchema = z.object({
  type: z.string(),
  value: z.string(),
  alt: z.string(),
});

export type ContentPartWire = z.infer<typeof ContentPartWireSchema>;

const ContentPartsWireSchema = z.array(ContentPartWireSchema).min(1);

/**
 * Encode one `ContentPart`. `field` names case field, for size error only.
 * `maxBytes` passed in (`ConfigSchema.MAX_CONTENT_PART_BYTES`), never read from env.
 *
 * TODO(asset store): large part carries reference not inline bytes; ceiling becomes per-provider.
 */
export function encodeContentPart(
  part: ContentPart,
  field: string,
  maxBytes: number
): ContentPartWire {
  if (part.value.byteLength > maxBytes) {
    throw new ContentPartTooLargeError(field, part.value.byteLength, maxBytes);
  }

  if (isTextMime(part.type)) {
    return {
      type: part.type,
      value: Buffer.from(part.value).toString("utf8"),
      alt: part.alt,
    };
  }

  return {
    type: part.type,
    value: Buffer.from(part.value).toString("base64"),
    alt: part.alt,
  };
}

/** Decode one wire `ContentPart` back to the domain shape. Lossless. */
export function decodeContentPart(wire: ContentPartWire): ContentPart {
  if (isTextMime(wire.type)) {
    return {
      type: wire.type,
      alt: wire.alt,
      value: encodeText(wire.value),
    };
  }

  return {
    type: wire.type,
    value: new Uint8Array(Buffer.from(wire.value, "base64")),
    alt: wire.alt,
  };
}

// ─── Whole-case codec ───────────────────────────────────────────────────────

export const CaseWireSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: ContentPartsWireSchema.optional(),
  anamnesis: z
    .array(z.object({ category: z.string(), answer: ContentPartsWireSchema }))
    .optional(),
  procedures: z
    .array(
      z.object({
        name: z.string(),
        relevance: ProcedureRelevanceSchema,
        result: ContentPartsWireSchema,
      })
    )
    .optional(),
});

export type CaseWire = z.infer<typeof CaseWireSchema>;

/** Encode generated `Case` for wire; single call point for both transports. */
export function encodeCase(c: Case, maxBytes: number): CaseWire {
  return {
    ...(c.patient !== undefined && { patient: c.patient }),
    ...(c.chiefComplaint !== undefined && {
      chiefComplaint: c.chiefComplaint.map((p) =>
        encodeContentPart(p, "chiefComplaint", maxBytes)
      ),
    }),
    ...(c.anamnesis !== undefined && {
      anamnesis: c.anamnesis.map((a) => ({
        category: a.category,
        answer: a.answer.map((p) =>
          encodeContentPart(p, `anamnesis[${a.category}].answer`, maxBytes)
        ),
      })),
    }),
    ...(c.procedures !== undefined && {
      procedures: c.procedures.map((p) => ({
        name: p.name,
        relevance: p.relevance,
        result: p.result.map((part) =>
          encodeContentPart(part, `procedures[${p.name}].result`, maxBytes)
        ),
      })),
    }),
  };
}

/** Decode a wire `Case` back to the domain shape. Lossless, order-preserving. */
export function decodeCase(wire: CaseWire): Case {
  return CaseSchema.parse({
    ...(wire.patient !== undefined && { patient: wire.patient }),
    ...(wire.chiefComplaint !== undefined && {
      chiefComplaint: wire.chiefComplaint.map(decodeContentPart),
    }),
    ...(wire.anamnesis !== undefined && {
      anamnesis: wire.anamnesis.map((a) => ({
        category: a.category,
        answer: a.answer.map(decodeContentPart),
      })),
    }),
    ...(wire.procedures !== undefined && {
      procedures: wire.procedures.map((p) => ({
        name: p.name,
        relevance: p.relevance,
        result: p.result.map(decodeContentPart),
      })),
    }),
  });
}
