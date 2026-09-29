import {
  translateRecordKeyed,
  translateTermsKeyed,
} from "@/core/graph/shared/translation/translate.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { AnamnesisCategory } from "@/core/graph/shared/domain/Anamnesis.js";
import type {
  Language,
  ForeignLanguage,
} from "@/core/graph/shared/domain/Language.js";

// ─── translate_anamnesis_categories_from_english ──────────────────────────────

export async function translateAnamnesisCategoriesFromEnglish(
  runtime: GraphRuntime,
  input: { categories: AnamnesisCategory[]; language: string },
  context?: RequestContext
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  const { categories, language } = input;
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
}

// ─── translate_procedure_nodes_from_english ────────────────────────────────────

/** Translation lookups are keyed by `nodeKey(path)`, shared by categories and procedures. */
export async function translateProcedureNodesFromEnglish(
  runtime: GraphRuntime,
  input: {
    /** One catalogue node (category or procedure) to translate: its key and own English name. */
    procedureNodes: { key: string; name: string }[];
    language: string;
  },
  context?: RequestContext
): Promise<Record<string, string>> {
  const { procedureNodes, language } = input;
  const translations: Record<string, string> = {};
  const missing: { key: string; name: string }[] = [];

  for (const node of procedureNodes) {
    const cached = runtime.catalogs.procedures.translation(node.key, language);
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
}

// ─── translate_rest_values ────────────────────────────────────────────────────

/** One LLM call translating every `ContentPart` text fragment (`alt`, plus decoded prose for text parts), keyed by path; see {@link caseTextMap}. Never sent: `value` bytes, procedure names, categories, enums/identifiers/numbers. */
export async function translateRestValues(
  runtime: GraphRuntime,
  input: { values: Record<string, string>; language: string },
  context?: RequestContext
): Promise<Record<string, string>> {
  const { values, language } = input;
  return translateRecordKeyed(runtime, {
    logTag: "TranslateRestValues",
    taskDescription:
      "Translate the provided medical case text fragments from English to a target language. Each fragment is independent free text (a chief complaint, an anamnesis answer, or a procedure result) — translate its meaning faithfully, preserving clinical accuracy.",
    contextLines: [`Target language: ${language}`],
    values,
    context,
  });
}

/**
 * Generates translations of anamnesis categories from English to a target language using an LLM.
 * @param englishCategories the anamnesis categories in English to translate
 * @param language the target language to translate the categories into
 * @returns a record mapping English categories to their translations in the target language
 */
export async function generateAnamnesisCategoriesFromEnglish(
  runtime: GraphRuntime,
  englishCategories: AnamnesisCategory[],
  language: Language,
  context?: RequestContext
): Promise<Record<AnamnesisCategory, AnamnesisCategory>> {
  return translateTermsKeyed(runtime, {
    logTag: "GenerateAnamnesisCategoriesFromEnglish",
    taskDescription: `Translate the provided anamnesis categories from English to a target language.`,
    contextLines: [`Target language: ${language}`],
    terms: englishCategories,
    context,
  });
}

/**
 * Translates a batch of catalogue node names (categories or procedures),
 * missing from the translation store, from English to `language`.
 * `byNodeKey` is `nodeKey(path) -> the node's own English name`; the key's
 * JSON path gives the model context (its position in the catalogue), only
 * the value is translated.
 */
export async function generateProceduresFromEnglish(
  runtime: GraphRuntime,
  byNodeKey: Record<string, string>,
  language: ForeignLanguage,
  context?: RequestContext
): Promise<Record<string, string>> {
  return translateRecordKeyed(runtime, {
    logTag: "GenerateProceduresFromEnglish",
    taskDescription: `Translate the provided items from English to a target language. Each key is the item's path in a medical procedure catalogue (a JSON array of category/procedure names from the root, ending in the item's own name) — it is context only. Translate ONLY the value, the item's own English name, into ${language}.`,
    contextLines: [`Target language: ${language}`],
    values: byNodeKey,
    context,
  });
}
