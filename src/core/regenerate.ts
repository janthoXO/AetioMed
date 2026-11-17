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
import type { ModalityField } from "@/core/graph/shared/modality/registry.js";
import type { RefineLevel } from "./graph/refine.js";
import {
  caseUnits,
  pathKey,
  withSources,
  type CasePath,
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

export { MODALITY_FIELD };

/** Pieces of one entry, and how the context's sources follow them. */
type EntryResult = {
  pieces: CasePiece[];
  update?: (context: GenerationContext) => GenerationContext;
};

/** Target part: its recorded source and the client's current alt. */
function partOf(context: GenerationContext, entry: Regenerate) {
  const path = entry.path as CasePath;
  const source = context.parts[pathKey(path)];
  const alt = entry.alts?.[path.at(-1) as number];
  if (!source) throw new InvalidPathError(path, "no such part");
  if (alt === undefined)
    throw new InvalidPathError(path, "`alts` must carry the part's alt");
  return { ...source, alt };
}

/** Chief complaint is one unit: its second path segment is already a part. */
function isPartPath(path: CasePath): boolean {
  return path[0] === "chiefComplaint" ? path.length === 2 : path.length === 3;
}

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
): Promise<EntryResult> {
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
      pieces: [{ path, how: "rerolled", value: c[field] }],
      update: (ctx) => withSources(ctx, path, caseUnits({ [field]: c[field] })),
    };
  }

  if (isPartPath(path)) {
    const [part] = await graph.rerolls.renderParts(MODALITY_FIELD[head], [
      partOf(context, entry),
    ]);
    return { pieces: [{ path, how: "rerolled", value: part! }] };
  }

  const unit = context.units[pathKey(path)];
  if (!unit) throw new InvalidPathError(path, "no such unit");
  const { parts } = await graph.rerolls.replanUnit(MODALITY_FIELD[head], unit, {
    diagnosis: context.diagnosis,
    outlineSections: sections,
  });
  return {
    pieces: [{ path, how: "rerolled", value: parts }],
    update: (ctx) => withSources(ctx, path, [[path, parts]]),
  };
}

/**
 * Refine below the outline (#272). `render`: the target text part again,
 * the instruction as a wording `hint`, same `alt`. `plan`: the target unit
 * (every unit of a field path) re-planned with the instruction and its
 * current parts; only changed parts rendered (`changedParts`).
 */
export async function refineBelow(
  graph: GraphAppContext,
  context: GenerationContext,
  entry: Regenerate,
  level: "plan" | "render"
): Promise<EntryResult> {
  const path = entry.path as CasePath;
  const head = path[0] as Exclude<GenerationFlag, "patient">;
  const field = MODALITY_FIELD[head];
  const instruction = entry.instruction!;

  if (level === "render") {
    const [part] = await graph.rerolls.renderParts(field, [
      { ...partOf(context, entry), hint: instruction },
    ]);
    return { pieces: [{ path, how: "refined", value: part! }] };
  }

  const target: CasePath =
    head === "chiefComplaint" ? ["chiefComplaint"] : path.slice(0, 2);
  // A field path re-plans every unit it has; units' keys are our own pathKeys.
  const unitPaths =
    path.length === 1 && head !== "chiefComplaint"
      ? Object.keys(context.units)
          .map((key) => JSON.parse(key) as CasePath)
          .filter((p) => p[0] === head)
      : [target];
  const results = await Promise.all(
    unitPaths.map(async (unitPath): Promise<EntryResult> => {
      const unit = context.units[pathKey(unitPath)];
      if (!unit) throw new InvalidPathError(unitPath, "no such unit");
      const current =
        path.length > 1
          ? (entry.alts ?? []).map((alt, i) => ({
              ...(context.parts[pathKey([...unitPath, i])] ?? {
                provider: "text",
                input: {},
              }),
              alt,
            }))
          : [];
      const { parts, changed } = await graph.rerolls.replanUnit(field, unit, {
        diagnosis: context.diagnosis,
        outlineSections: outlineSections(context.plan),
        revision: {
          instruction,
          current,
          focus: isPartPath(path) ? (path.at(-1) as number) : undefined,
        },
      });
      return {
        pieces: [
          {
            path: unitPath,
            how: "refined",
            value: parts,
            ...(changed && { changedParts: changed }),
          },
        ],
        update: changed
          ? (ctx) => ({
              ...ctx,
              parts: {
                ...ctx.parts,
                ...Object.fromEntries(
                  changed.map((i, k) => {
                    const { provider, input } = parts[k]!.source!;
                    return [pathKey([...unitPath, i]), { provider, input }];
                  })
                ),
              },
            })
          : (ctx) => withSources(ctx, unitPath, [[unitPath, parts]]),
      };
    })
  );
  return {
    pieces: results.flatMap((r) => r.pieces),
    update: (ctx) => results.reduce((acc, r) => r.update!(acc), ctx),
  };
}

/** Results of concurrent entries combined; context sources updated after. */
export function combine(
  context: GenerationContext,
  results: EntryResult[]
): { pieces: CasePiece[]; context: GenerationContext } {
  return {
    pieces: results.flatMap((r) => r.pieces),
    context: results.reduce((ctx, r) => r.update?.(ctx) ?? ctx, context),
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
export function refineRequest(
  context: GenerationContext,
  entry: Regenerate,
  isText: (field: ModalityField, provider: string) => boolean
) {
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
  // Render level: wording of one text part only.
  const source = isPartPath(path) ? context.parts[pathKey(path)] : undefined;
  const head = path[0] as keyof typeof MODALITY_FIELD;
  const levels: RefineLevel[] =
    source && isText(MODALITY_FIELD[head], source.provider)
      ? ["outline", "plan", "render"]
      : ["outline", "plan"];
  return { target, alts: entry.alts, instruction, levels };
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
