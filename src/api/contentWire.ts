// Wire encoding for `ContentPart[]` fields (issue 11 §5) — a boundary
// concern, not a domain one, so it lives here rather than under
// `src/core/graph/models/`. Both transports (`transports/rest/routes/cases.router.ts`
// and the NATS publisher, `transports/nats/cases.handler.ts`) encode a
// generated `Case` through `encodeCase` before it leaves the process:
// without this, `Uint8Array` JSON-stringifies to `{"0":102,"1":101,…}`.
//
// Encoding, per MIME class:
//   text/*          -> UTF-8 string, verbatim
//   everything else -> base64
// `alt` is ALWAYS emitted and ALWAYS read back (issue 21 §8): it is now an
// independent label authored by the planner, not derivable from `value` —
// a text part's prose lives in `value`, its short label lives in `alt`, and
// the two can legitimately differ. The round trip is lossless and
// order-preserving.
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

/**
 * One `ContentPart` on the wire. `alt` is required for every part — a text
 * part's `alt` is no longer derivable from `value` (issue 21 §2), so
 * omitting it would silently drop the label.
 */
export const ContentPartWireSchema = z.object({
  type: z.string(),
  value: z.string(),
  alt: z.string(),
});

export type ContentPartWire = z.infer<typeof ContentPartWireSchema>;

const ContentPartsWireSchema = z.array(ContentPartWireSchema).min(1);

/**
 * Encode one domain `ContentPart` to its wire shape. `field` names the case
 * field being encoded, for the size-ceiling error message only.
 *
 * `maxBytes` is passed in, never read from `process.env` here: config
 * resolution belongs to the composition root
 * (`ConfigSchema.MAX_CONTENT_PART_BYTES`), and a hidden env read would make
 * this module's behaviour depend on ambient state — the exact pattern the
 * rest of this codebase removed.
 *
 * TODO(asset store): once an asset store exists, a large part carries a
 * reference instead of inline bytes — additive to this design, since `type`
 * already governs interpretation — and this global ceiling becomes
 * per-provider instead.
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

/** Encode a generated `Case` for the wire — the one place both transports
 * call through (issue 11 §5). */
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
