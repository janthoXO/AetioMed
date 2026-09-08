import z from "zod";
import { ContentPartsSchema } from "./ContentPart.js";
import { PlannedPartSchema } from "../modality/ports.js";

export const ProcedureNameSchema = z
  .string()
  .describe("Name of the medical procedure");

export type ProcedureName = z.infer<typeof ProcedureNameSchema>;

export const ProcedureRelevanceSchema = z.enum([
  "obligatory",
  "optional",
  "contraindicated",
]);
export type ProcedureRelevance = z.infer<typeof ProcedureRelevanceSchema>;

export const ProcedureSchema = z.object({
  name: ProcedureNameSchema,
});

export type Procedure = z.infer<typeof ProcedureSchema>;

export function buildProcedureSchema(procedureNames?: ProcedureName[]) {
  if (procedureNames?.length) {
    return ProcedureSchema.extend({
      name: z.literal(procedureNames).describe("Name of the medical procedure"),
    });
  }

  return ProcedureSchema;
}

/**
 * Procedure with a relevance and a result — both are decided non-blinded,
 * once a procedure that was chosen during the blinded solver step has had
 * its result generated. `relevance` is a judgment relative to the TRUE
 * diagnosis (which the blinded solver never sees), so it cannot be produced
 * by the blinded step — see `procedures.aigateway.ts`.
 *
 * `result` is a domain content-parts field (issue 11): one or more content
 * parts. See `ContentPart.ts` for additive-parts semantics.
 */
export const ProcedureResultSchema = ProcedureSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: ContentPartsSchema.describe(
    "Result of the procedure, as one or more content parts"
  ),
});
export type ProcedureResult = z.infer<typeof ProcedureResultSchema>;

/**
 * LLM-facing counterpart to `ProcedureResultSchema`: `result` stays a plain
 * `z.string()` — the LLM is never asked to emit bytes or base64 (issue 11
 * §3). Callers wrap `result` into a `ContentPart` to build a domain
 * `ProcedureResult` (`Procedure` type above).
 */
export const ProcedureResultTextSchema = ProcedureSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: z.string().describe("Result of the procedure, if applicable"),
});

export function buildProcedureResultTextSchema(
  procedureNames?: ProcedureName[]
) {
  if (procedureNames?.length) {
    return ProcedureResultTextSchema.extend({
      name: z.literal(procedureNames).describe("Name of the medical procedure"),
    });
  }
  return ProcedureResultTextSchema;
}

/**
 * A procedure the blinded-solver loop has decided on but not yet rendered
 * (issue 21 §7): `relevance` is still decided non-blinded (same reasoning
 * as `ProcedureResultSchema` above), but `result` doesn't exist yet — only
 * an ORDERED list of render requests does. `render_results`
 * (`02graphs/02case-generation/03procedure/index.ts`) is the only node that
 * turns these into `ProcedureResult[]`, once for the whole list, after the
 * case is solved.
 *
 * `parts` carries `PlannedPart`s, not `ContentPart`s — no bytes exist yet.
 * Each part's `alt` here is NOT the short label it is everywhere else in
 * this codebase: for a procedure result it is the self-contained statement
 * of the clinical finding itself, because the blinded solver reasons over
 * `alt` and nothing else (the bytes are rendered only after the case is
 * solved). See `03aigateway/procedures.aigateway.ts`'s `planProcedureResults`
 * doc comment for the prompt requirement this enforces.
 */
export const PlannedProcedureSchema = z.object({
  name: ProcedureNameSchema,
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the TRUE diagnosis"
  ),
  parts: z
    .array(PlannedPartSchema)
    .min(1)
    .describe("Ordered render requests that will compose this result"),
});
export type PlannedProcedure = z.infer<typeof PlannedProcedureSchema>;
