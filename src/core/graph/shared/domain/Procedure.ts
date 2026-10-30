import z from "zod";
import { ContentPartsSchema } from "./ContentPart.js";
import { PlannedPartSchema } from "@/core/graph/shared/modality/ports.js";
import { ProcedureRefSchema } from "./ProcedureTree.js";
import type { Patient } from "./Patient.js";

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

/**
 * One catalogue reference range (FHIR `ObservationDefinition.qualifiedInterval`):
 * `low`/`high` and `age` (in years) inclusive, as FHIR ranges are.
 */
export const ReferenceBandSchema = z.object({
  low: z.number().optional(),
  high: z.number().optional(),
  unit: z.string().optional(),
  gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  age: z
    .object({ low: z.number().optional(), high: z.number().optional() })
    .optional(),
});
export type ReferenceBand = z.infer<typeof ReferenceBandSchema>;

/**
 * The band for this patient, first tier that has one: own gender with a
 * fitting age range, own gender without age, no gender with a fitting age
 * range, no gender without age. Overlapping age ranges: the lower band wins.
 * A patient that is only outline text (or absent) cannot be matched in code,
 * so every band goes to the planner with its context.
 */
export function bandsFor(
  bands: ReferenceBand[],
  patient: Patient | string | undefined
): ReferenceBand[] {
  if (typeof patient !== "object") return bands;
  const fits = (b: ReferenceBand) =>
    b.age !== undefined &&
    (b.age.low ?? 0) <= patient.age &&
    patient.age <= (b.age.high ?? Infinity);
  const tiers = [
    (b: ReferenceBand) => b.gender === patient.gender && fits(b),
    (b: ReferenceBand) => b.gender === patient.gender && !b.age,
    (b: ReferenceBand) => b.gender === undefined && fits(b),
    (b: ReferenceBand) => b.gender === undefined && !b.age,
  ];
  for (const tier of tiers) {
    const match = bands
      .filter(tier)
      .sort((a, b) => (a.age?.low ?? 0) - (b.age?.low ?? 0))[0];
    if (match) return [match];
  }
  return [];
}

const years = (n: number) => +n.toFixed(2);

/** `3.5–5.1 mmol/L (female, age 18–65 y)` for a prompt. */
export function formatBand(band: ReferenceBand): string {
  const { low, high, unit, gender, age } = band;
  const range =
    low !== undefined && high !== undefined
      ? `${low}–${high}`
      : low !== undefined
        ? `≥ ${low}`
        : `≤ ${high}`;
  const context = [
    gender,
    age &&
      `age ${years(age.low ?? 0)}–${age.high === undefined ? "∞" : years(age.high)} y`,
  ].filter(Boolean);
  return `${range}${unit ? ` ${unit}` : ""}${context.length ? ` (${context.join(", ")})` : ""}`;
}

/**
 * `Case.procedures` leaf: relevance and result, both decided non-blinded.
 * `relevance` is judged against the TRUE diagnosis, so the blinded step
 * cannot produce it (see `procedures.aigateway.ts`). `result` is content
 * parts; see `ContentPart.ts`. `order` is the 0-based position in which it was
 * ordered: the tree groups by category, `order` keeps the workup sequence.
 */
export const ProcedureResultSchema = ProcedureSchema.extend({
  code: z.string().optional().describe("Catalogue code; absent in freeform"),
  order: z.number().int().min(0).describe("0-based position in the workup"),
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the diagnosis"
  ),
  result: ContentPartsSchema.describe(
    "Result of the procedure, as one or more content parts"
  ),
});
export type ProcedureResult = z.infer<typeof ProcedureResultSchema>;

/**
 * Procedure decided by the solver loop but not yet rendered: non-blinded
 * `relevance`, plus an ORDERED list of render requests instead of `result`.
 * `render_results` (`03procedure/index.ts`) is the only node turning these
 * into `ProcedureResult[]`, once, after solving.
 *
 * `parts` are `PlannedPart`s, no bytes yet. Here `alt` is NOT a short label:
 * it is the self-contained clinical finding, since the blinded solver reasons
 * over `alt` alone. See `planProcedureResults` in `procedures.aigateway.ts`.
 */
export const PlannedProcedureSchema = ProcedureRefSchema.extend({
  relevance: ProcedureRelevanceSchema.describe(
    "Relevance of the procedure to the TRUE diagnosis"
  ),
  parts: z
    .array(PlannedPartSchema)
    .min(1)
    .describe("Ordered render requests that will compose this result"),
});
export type PlannedProcedure = z.infer<typeof PlannedProcedureSchema>;
