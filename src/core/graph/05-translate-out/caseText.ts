import type { Case } from "@/core/graph/shared/domain/Case.js";
import {
  leaves,
  mapTree,
  nodeKey,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type { ContentPart } from "@/core/graph/shared/domain/ContentPart.js";

/**
 * Every `ContentPart[]` field on `Case` with its path prefix (see
 * {@link caseTextMap}/{@link applyCaseTextTranslations}/{@link translateProcedureTree}).
 * `chiefComplaint`/`anamnesis` index by position: names are translated by the
 * defined pass, keying on them would couple the passes. `procedures` keys by
 * `order` (leaf's stable position in the workup), not a DFS index — the tree
 * groups by category, `order` is what stays unique and stable.
 */
function contentPartFields(
  c: Case
): { prefix: string; parts: ContentPart[] }[] {
  const fields: { prefix: string; parts: ContentPart[] }[] = [];

  if (c.chiefComplaint) {
    fields.push({ prefix: "chiefComplaint", parts: c.chiefComplaint });
  }
  c.anamnesis?.forEach((a, i) => {
    fields.push({ prefix: `anamnesis.${i}.answer`, parts: a.answer });
  });
  if (c.procedures) {
    for (const { leaf } of leaves(c.procedures)) {
      fields.push({
        prefix: `procedures.${leaf.order}.result`,
        parts: leaf.result,
      });
    }
  }

  return fields;
}

/** Only `.alt` is translated; `value` is already in the target language (renderers write it) and passes through byte-identical. Missing key falls back to original. */
function translateParts(
  prefix: string,
  parts: ContentPart[],
  translations: Record<string, string>
): ContentPart[] {
  return parts.map((part, i) => ({
    ...part,
    alt: translations[`${prefix}.${i}.alt`] ?? part.alt,
  }));
}

/**
 * Flat keyed map of every `ContentPart` `alt` in case; sole input of rest pass. Keys: `chiefComplaint.0.alt`, `anamnesis.2.answer.0.alt`, `procedures.1.result.3.alt`.
 * `value` never reaches the map: renderers already wrote it in the target language (#192).
 */
export function caseTextMap(c: Case): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { prefix, parts } of contentPartFields(c)) {
    parts.forEach((part, i) => {
      map[`${prefix}.${i}.alt`] = part.alt;
    });
  }
  return map;
}

/**
 * Apply translated `caseTextMap` onto content-part fields: `alt` translated, `value` byte-identical for every MIME. Missing key falls back to original. Part count and order preserved.
 *
 * Returns only `chiefComplaint`/`anamnesis`; `patient` and `anamnesis[].category`
 * untouched here (caller applies `definedTranslations`). `procedures` is
 * handled separately by {@link translateProcedureTree}, which translates
 * both node names and result parts in one tree walk.
 */
export function applyCaseTextTranslations(
  c: Case,
  translations: Record<string, string>
): Pick<Case, "chiefComplaint" | "anamnesis"> {
  return {
    ...(c.chiefComplaint && {
      chiefComplaint: translateParts(
        "chiefComplaint",
        c.chiefComplaint,
        translations
      ),
    }),
    ...(c.anamnesis && {
      anamnesis: c.anamnesis.map((a, i) => ({
        ...a,
        answer: translateParts(`anamnesis.${i}.answer`, a.answer, translations),
      })),
    }),
  };
}

/**
 * Rebuilds `case.procedures` with translated node names (categories and
 * procedures, from the defined pass, keyed by `nodeKey`) and translated
 * result parts (from the rest pass, keyed by `procedures.<order>.result`,
 * see {@link caseTextMap}) in one tree walk. A miss in either map falls back
 * to the original (English) value.
 */
export function translateProcedureTree(
  procedures: NonNullable<Case["procedures"]>,
  procedureNodeTranslations: Record<string, string>,
  restTranslations: Record<string, string>
): NonNullable<Case["procedures"]> {
  return mapTree(procedures, {
    category: (path, name) => procedureNodeTranslations[nodeKey(path)] ?? name,
    leaf: (path, leaf) => ({
      ...leaf,
      name:
        procedureNodeTranslations[nodeKey([...path, leaf.name])] ?? leaf.name,
      result: translateParts(
        `procedures.${leaf.order}.result`,
        leaf.result,
        restTranslations
      ),
    }),
  });
}
