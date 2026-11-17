import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { DiagnosisSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import { GenerationFlagSchema } from "@/core/graph/shared/domain/GenerationFlags.js";
import { DifficultySchema } from "@/core/graph/shared/domain/Difficulty.js";
import { OutlineSegmentsSchema } from "@/core/graph/shared/outline/segments.js";
import { UserInstructionsSchema } from "@/core/graph/shared/domain/UserInstructions.js";
import { AppError } from "./graph/errors/AppError.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import type { ContentPart } from "@/core/graph/shared/domain/ContentPart.js";
import { leaves } from "@/core/graph/shared/domain/ProcedureTree.js";

/**
 * Generation context (#272): every generator internal a later call needs,
 * handed out as an opaque string on every response and sent back unread.
 * Keeps the generator stateless (#159): no store, any replica answers.
 */
export const GenerationContextSchema = z.object({
  v: z.literal(1),
  /** Resolved: a continuation skips `resolveDiagnosis`. */
  diagnosis: DiagnosisSchema,
  difficulty: DifficultySchema.optional(),
  /** Requested flags of the first call. */
  generationFlags: z.array(GenerationFlagSchema).min(1),
  /** First call's, raw: a whole-outline reroll plans from the same inputs. */
  userInstructions: UserInstructionsSchema.optional(),
  /** Fields the case has; empty while only a plan exists. */
  fields: z.array(GenerationFlagSchema),
  /** Working-language plan: English, or the request language (plan mode, sandwich off). */
  plan: OutlineSegmentsSchema,
  /**
   * What a plan-mode reviewer was shown, per segment index. A handed-back
   * segment equal to it is untouched: `plan[i]` used, no translation.
   */
  localized: z.record(z.string(), z.string()).optional(),
  /** Provider and input of every rendered part, by {@link pathKey}. */
  parts: z
    .record(z.string(), z.object({ provider: z.string(), input: z.unknown() }))
    .default({}),
  /** English plan unit key (category, `refKey`) of every unit, by {@link pathKey}. */
  units: z.record(z.string(), z.string()).default({}),
});

export type GenerationContext = z.infer<typeof GenerationContextSchema>;

/** Path of a case node (`["procedures", 3, 0]`): built, never parsed. */
export type CasePath = (string | number)[];

/** Record key of a {@link CasePath}. */
export const pathKey = (path: CasePath) => JSON.stringify(path);

/** A case's content units with their client paths. */
export type CaseUnits = [CasePath, ContentPart[]][];

/**
 * Content units by path as the client addresses them: `["chiefComplaint"]`,
 * `["anamnesis", category]` (category as in the case), `["procedures", order]`.
 */
export function caseUnits(c: Case): CaseUnits {
  const units: CaseUnits = [];
  if (c.chiefComplaint) units.push([["chiefComplaint"], c.chiefComplaint]);
  for (const a of c.anamnesis ?? [])
    units.push([["anamnesis", a.category], a.answer]);
  for (const { leaf } of c.procedures ? leaves(c.procedures) : [])
    units.push([["procedures", leaf.order], leaf.result]);
  return units;
}

/** Every rendered part's source (`[...unitPath, i]`) and every unit's plan key. */
export function partSources(
  units: CaseUnits
): Pick<GenerationContext, "parts" | "units"> {
  const sources: Pick<GenerationContext, "parts" | "units"> = {
    parts: {},
    units: {},
  };
  for (const [path, parts] of units) {
    parts.forEach((part, i) => {
      if (!part.source) return;
      const { provider, input, unit } = part.source;
      sources.parts[pathKey([...path, i])] = { provider, input };
      sources.units[pathKey(path)] = unit;
    });
  }
  return sources;
}

/**
 * `context` with the sources under `path` (a field, a unit) replaced by
 * those of `units`, rendered anew there.
 */
export function withSources(
  context: GenerationContext,
  path: CasePath,
  units: CaseUnits
): GenerationContext {
  const prefix = pathKey(path).slice(0, -1);
  const kept = <T>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => key !== pathKey(path) && !key.startsWith(prefix + ",")
      )
    );
  const fresh = partSources(units);
  return {
    ...context,
    parts: { ...kept(context.parts), ...fresh.parts },
    units: { ...kept(context.units), ...fresh.units },
  };
}

/** A `context` that does not decode: not ours, truncated, or an old version. */
export class InvalidContextError extends AppError {
  constructor(details?: string) {
    super("Invalid generation context", "INVALID_CONTEXT", 400, details);
  }
}

/** Versioned JSON → gzip → base64. */
export function encodeContext(context: GenerationContext): string {
  return gzipSync(JSON.stringify(context)).toString("base64");
}

/** Inverse of {@link encodeContext}; Zod-parsed, never cast. */
export function decodeContext(blob: string): GenerationContext {
  let raw: unknown;
  try {
    raw = JSON.parse(gunzipSync(Buffer.from(blob, "base64")).toString("utf8"));
  } catch (error) {
    throw new InvalidContextError(
      error instanceof Error ? error.message : String(error)
    );
  }
  const parsed = GenerationContextSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidContextError(parsed.error.message);
  return parsed.data;
}
