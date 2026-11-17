import { z } from "zod";
import type { Regenerate } from "@/api/index.js";
import {
  refLabel,
  refOfKey,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import { GenerationFlagSchema } from "@/core/graph/shared/domain/GenerationFlags.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import type { ContentPart } from "@/core/graph/shared/domain/ContentPart.js";
import type { Difficulty } from "@/core/graph/shared/domain/Difficulty.js";
import type { GenerationFlag } from "@/core/graph/shared/domain/GenerationFlags.js";
import {
  outlineSections,
  sectionHeadings,
} from "@/core/graph/shared/outline/segments.js";
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

/** A refine: an instruction, or an outline section reroll ("an alternative"). */
export function isRefine(entry: Regenerate): boolean {
  return (
    entry.instruction !== undefined ||
    (entry.path[0] === "outline" && entry.path.length === 2)
  );
}

const ALTERNATIVE =
  "Write an alternative version of the target section with different concrete details; keep every other section consistent with it.";

/** What the refiner is told about an entry, and which levels it may pick. */
export function refineRequest(context: GenerationContext, entry: Regenerate) {
  const path = entry.path as CasePath;
  const instruction = entry.instruction ?? ALTERNATIVE;
  const outlineOnly = (target: string) => ({
    target,
    instruction,
    levels: ["outline" as const],
  });
  if (path[0] === "outline") {
    if (path.length === 1) return outlineOnly("the whole outline");
    const heading = sectionHeadings(context.plan).find(
      (h) => h.index === path[1]
    )?.heading;
    if (!heading) throw new InvalidPathError(path, "no such section");
    return outlineOnly(`the section "${heading}"`);
  }
  // Patient is no parts: only its outline section can change.
  if (path[0] === "patient") return outlineOnly('the section "## Patient"');

  let target = `the ${path[0]} field`;
  if (path.length > 1) {
    const unitPath =
      path[0] === "chiefComplaint" ? ["chiefComplaint"] : path.slice(0, 2);
    const unit = context.units[pathKey(unitPath)];
    if (!unit) throw new InvalidPathError(path, "no such unit");
    target =
      path[0] === "anamnesis"
        ? `the anamnesis category "${unit}"`
        : path[0] === "procedures"
          ? `the result of procedure "${refLabel(refOfKey(unit))}"`
          : "the chief complaint";
    if (path.length > unitPath.length) target += `, part ${path.at(-1)}`;
  }
  return {
    target,
    alts: entry.alts,
    instruction,
    levels: ["outline" as const, "plan" as const],
  };
}

export const ProposalSchema = z.object({
  changed: z
    .array(z.object({ field: GenerationFlagSchema, why: z.string() }))
    .describe(
      "Case fields whose outline sections changed: accept to regenerate them."
    ),
  background: z
    .array(
      z.object({
        section: z
          .number()
          .int()
          .describe("Index of the section's heading segment in the plan"),
        heading: z.string().describe("Section heading, localized, for display"),
        summary: z.string(),
      })
    )
    .describe("Changed sections no case field shows: always taken on accept."),
});
export type Proposal = z.infer<typeof ProposalSchema>;
