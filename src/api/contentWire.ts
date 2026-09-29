// Wire encoding for `ContentPart[]`. Both transports encode `Case` through
// `encodeCase`; raw `Uint8Array` would JSON-stringify to `{"0":102,…}`.
// text/* -> UTF-8 string verbatim; else base64.
// `alt` always emitted and read back: independent of `value`, can differ. Lossless, order-preserving.
import { z } from "zod";
import {
  encodeText,
  type ContentPart,
} from "@/core/graph/shared/domain/ContentPart.js";
import { PatientSchema } from "@/core/graph/shared/domain/Patient.js";
import { ProcedureRelevanceSchema } from "@/core/graph/shared/domain/Procedure.js";
import {
  procedureTreeSchema,
  mapTree,
  refLabel,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import { CaseSchema, type Case } from "@/core/graph/shared/domain/Case.js";

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
  procedures: procedureTreeSchema(
    z.object({
      name: z.string(),
      order: z.number().int().min(0),
      relevance: ProcedureRelevanceSchema,
      result: ContentPartsWireSchema,
    })
  ).optional(),
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
      procedures: mapTree(c.procedures, {
        leaf: (path, leaf) => ({
          name: leaf.name,
          order: leaf.order,
          relevance: leaf.relevance,
          result: leaf.result.map((part) =>
            encodeContentPart(
              part,
              `procedures[${refLabel({ path, name: leaf.name })}].result`,
              maxBytes
            )
          ),
        }),
      }),
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
      procedures: mapTree(wire.procedures, {
        leaf: (_path, leaf) => ({
          name: leaf.name,
          order: leaf.order,
          relevance: leaf.relevance,
          result: leaf.result.map(decodeContentPart),
        }),
      }),
    }),
  });
}
