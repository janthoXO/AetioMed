import type { Regenerate } from "@/api/index.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import type { ContentPart } from "@/core/graph/shared/domain/ContentPart.js";
import type { Difficulty } from "@/core/graph/shared/domain/Difficulty.js";
import type { GenerationFlag } from "@/core/graph/shared/domain/GenerationFlags.js";
import { outlineSections } from "@/core/graph/shared/outline/segments.js";
import type { GraphAppContext } from "./graph/appContext.js";
import { AppError } from "./graph/errors/AppError.js";
import {
  caseUnits,
  pathKey,
  withSources,
  type CasePath,
  type CaseUnits,
  type GenerationContext,
} from "./generationContext.js";

/**
 * One regenerated piece of a case: the new value at `path` (domain shape;
 * the transports wire-encode it). `changedParts`: which parts of a unit
 * changed, when not all.
 */
export type CasePiece = {
  path: CasePath;
  how: "rerolled" | "refined";
  changedParts?: number[];
  value: NonNullable<Case[keyof Case]> | ContentPart[] | ContentPart;
};

/** A path the context does not know, or a part path without its `alts`. */
export class InvalidPathError extends AppError {
  constructor(path: CasePath, why: string) {
    super(
      `Cannot regenerate ${JSON.stringify(path)}: ${why}`,
      "INVALID_PATH",
      400
    );
  }
}

const MODALITY_FIELD = {
  chiefComplaint: "chiefComplaint",
  anamnesis: "anamnesis",
  procedures: "procedureResult",
} as const;

/**
 * Reroll (#272): rerun the target's own step from unchanged inputs. Field:
 * the case graph narrowed to it. Unit: its planner narrowed to it, then
 * render. Part: render again from the recorded provider + input, same `alt`.
 */
export async function reroll(
  graph: GraphAppContext,
  context: GenerationContext,
  entry: Regenerate,
  difficulty: Difficulty | undefined
): Promise<{ piece: CasePiece; sources?: [CasePath, CaseUnits] }> {
  const path = entry.path as CasePath;
  const head = path[0] as Exclude<GenerationFlag, "patient">;
  const sections = outlineSections(context.plan);

  if (path.length === 1) {
    const field = path[0] as GenerationFlag;
    const c = await graph.renderCase({
      diagnosis: context.diagnosis,
      generationFlags: [field],
      difficulty,
      outlineSections: sections,
    });
    if (c[field] === undefined)
      throw new InvalidPathError(path, "not generated");
    return {
      piece: { path, how: "rerolled", value: c[field] },
      sources: [path, caseUnits({ [field]: c[field] })],
    };
  }

  // Chief complaint is one unit: its second segment is already a part.
  const isPart = head === "chiefComplaint" || path.length === 3;
  if (isPart) {
    const source = context.parts[pathKey(path)];
    const alt = entry.alts?.[path.at(-1) as number];
    if (!source) throw new InvalidPathError(path, "no such part");
    if (alt === undefined)
      throw new InvalidPathError(path, "`alts` must carry the part's alt");
    const [part] = await graph.rerolls.renderParts(MODALITY_FIELD[head], [
      { ...source, alt },
    ]);
    return { piece: { path, how: "rerolled", value: part! } };
  }

  const unit = context.units[pathKey(path)];
  if (!unit) throw new InvalidPathError(path, "no such unit");
  const parts = await graph.rerolls.replanUnit(
    head === "anamnesis" ? "anamnesis" : "procedureResult",
    unit,
    { diagnosis: context.diagnosis, outlineSections: sections }
  );
  return {
    piece: { path, how: "rerolled", value: parts },
    sources: [path, [[path, parts]]],
  };
}

/** Every entry concurrently, one job slot; context sources updated after. */
export async function rerollAll(
  graph: GraphAppContext,
  context: GenerationContext,
  entries: Regenerate[],
  difficulty: Difficulty | undefined
): Promise<{ pieces: CasePiece[]; context: GenerationContext }> {
  const results = await Promise.all(
    entries.map((entry) => reroll(graph, context, entry, difficulty))
  );
  return {
    pieces: results.map((r) => r.piece),
    context: results.reduce(
      (ctx, r) => (r.sources ? withSources(ctx, ...r.sources) : ctx),
      context
    ),
  };
}
