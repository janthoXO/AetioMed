import z from "zod";
import { generateAnamnesisCategoriesFromEnglish } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import { generateProceduresFromEnglish } from "@/core/graph/03aigateway/procedures.aigateway.js";
import { translateRecordKeyed } from "@/core/graph/03aigateway/translate.helper.js";
import type { Case } from "@/core/graph/models/Case.js";
import { AnamnesisCategorySchema } from "@/core/graph/models/Anamnesis.js";
import type { AnamnesisCategory } from "@/core/graph/models/Anamnesis.js";
import { leaves, mapTree, nodeKey } from "@/core/graph/models/ProcedureTree.js";
import {
  encodeText,
  textOfPart,
  type ContentPart,
} from "@/core/graph/models/ContentPart.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── translate_anamnesis_categories_from_english ──────────────────────────────

const TranslateAnamnesisCategoriesFromEnglishInputSchema = z.object({
  categories: z.array(AnamnesisCategorySchema),
  language: z.string(),
});

export const translateAnamnesisCategoriesFromEnglish: Tool<
  z.infer<typeof TranslateAnamnesisCategoriesFromEnglishInputSchema>,
  Record<AnamnesisCategory, AnamnesisCategory>
> = {
  name: "translate_anamnesis_categories_from_english",
  description:
    "Translate anamnesis category names from English to the target language, using a cache.",
  inputSchema: TranslateAnamnesisCategoriesFromEnglishInputSchema,
  invoke: async ({ categories, language }, runtime, context) => {
    const translations: Record<AnamnesisCategory, AnamnesisCategory> = {};
    const missing: AnamnesisCategory[] = [];

    for (const category of categories) {
      const cached = runtime.catalogs.anamnesis.fromEnglish(category, language);
      if (cached) {
        translations[category] = cached;
      } else {
        missing.push(category);
      }
    }

    if (missing.length > 0) {
      const generated = await generateAnamnesisCategoriesFromEnglish(
        runtime,
        missing,
        language,
        context
      );
      Object.assign(translations, generated);
      runtime.catalogs.anamnesis.saveTranslations(generated, language);
    }

    return translations;
  },
};

// ─── translate_procedure_nodes_from_english ────────────────────────────────────

/** One catalogue node (category or procedure) to translate: its key and own English name. */
const ProcedureNodeSchema = z.object({
  key: z.string(),
  name: z.string(),
});

const TranslateProcedureNodesFromEnglishInputSchema = z.object({
  procedureNodes: z.array(ProcedureNodeSchema),
  language: z.string(),
});

/** Translation lookups are keyed by `nodeKey(path)`, shared by categories and procedures. */
export const translateProcedureNodesFromEnglish: Tool<
  z.infer<typeof TranslateProcedureNodesFromEnglishInputSchema>,
  Record<string, string>
> = {
  name: "translate_procedure_nodes_from_english",
  description:
    "Translate procedure catalogue node names (categories and procedures) from English to the target language, using a cache.",
  inputSchema: TranslateProcedureNodesFromEnglishInputSchema,
  invoke: async ({ procedureNodes, language }, runtime, context) => {
    const translations: Record<string, string> = {};
    const missing: { key: string; name: string }[] = [];

    for (const node of procedureNodes) {
      const cached = runtime.catalogs.procedures.translation(
        node.key,
        language
      );
      if (cached !== undefined) {
        translations[node.key] = cached;
      } else {
        missing.push(node);
      }
    }

    if (missing.length > 0) {
      const byNodeKey = Object.fromEntries(missing.map((n) => [n.key, n.name]));
      const generated = await generateProceduresFromEnglish(
        runtime,
        byNodeKey,
        language,
        context
      );
      Object.assign(translations, generated);
      runtime.catalogs.procedures.saveTranslations(generated, language);
    }

    return translations;
  },
};

// ─── translate_rest_values ────────────────────────────────────────────────────

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

/** `.alt` translated always; `text/plain` also gets `.text` -> `value` via `encodeText`. Missing key falls back to original. */
function translateParts(
  prefix: string,
  parts: ContentPart[],
  translations: Record<string, string>
): ContentPart[] {
  return parts.map((part, i) => {
    const translatedAlt = translations[`${prefix}.${i}.alt`] ?? part.alt;
    if (part.type !== "text/plain") {
      return { ...part, alt: translatedAlt };
    }
    const translatedText =
      translations[`${prefix}.${i}.text`] ?? textOfPart(part);
    return {
      type: "text/plain",
      value: encodeText(translatedText),
      alt: translatedAlt,
    };
  });
}

/**
 * Flat keyed map of every `ContentPart` text fragment in case; sole input of rest pass. Keys: `chiefComplaint.0.alt`, `anamnesis.2.answer.0.text`, `procedures.1.result.3.alt`.
 *
 * Every part gives `.alt`; `text/*` part also gives `.text` (decoded prose via `textOfPart`). Non-text `value` bytes never reach map or prompt.
 *
 * `.alt` and `.text` currently equal for text parts (same string); duplication expected. They diverge when `alt` differs from rendered prose.
 */
export function caseTextMap(c: Case): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { prefix, parts } of contentPartFields(c)) {
    parts.forEach((part, i) => {
      map[`${prefix}.${i}.alt`] = part.alt;
      if (part.type === "text/plain") {
        map[`${prefix}.${i}.text`] = textOfPart(part);
      }
    });
  }
  return map;
}

/**
 * Apply translated `caseTextMap` onto content-part fields. `text/plain` part: `.text` -> `value` (via `encodeText`), `.alt` -> `alt`, independently. Other MIME: `value` byte-identical, only `alt` translated. Missing key falls back to original. Part count and order preserved.
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

const TranslateRestValuesInputSchema = z.object({
  values: z.record(z.string(), z.string()),
  language: z.string(),
});

/** One LLM call translating every `ContentPart` text fragment (`alt`, plus decoded prose for text parts), keyed by path; see {@link caseTextMap}. Never sent: `value` bytes, procedure names, categories, enums/identifiers/numbers. */
export const translateRestValues: Tool<
  z.infer<typeof TranslateRestValuesInputSchema>,
  Record<string, string>
> = {
  name: "translate_rest_values",
  description:
    "Translate every free-text content-part value in a case from English to the target language, keyed by stable path.",
  inputSchema: TranslateRestValuesInputSchema,
  invoke: async ({ values, language }, runtime, context) =>
    translateRecordKeyed(runtime, {
      logTag: "TranslateRestValues",
      taskDescription:
        "Translate the provided medical case text fragments from English to a target language. Each fragment is independent free text (a chief complaint, an anamnesis answer, or a procedure result) — translate its meaning faithfully, preserving clinical accuracy.",
      contextLines: [`Target language: ${language}`],
      values,
      context,
    }),
};

export const translationFromEnglishTools = {
  translateAnamnesisCategoriesFromEnglish,
  translateProcedureNodesFromEnglish,
  translateRestValues,
} as const;
