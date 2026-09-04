import z from "zod";
import { generateAnamnesisCategoriesFromEnglish } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import { generateProceduresFromEnglish } from "@/core/graph/03aigateway/procedures.aigateway.js";
import { translateRecordKeyed } from "@/core/graph/03aigateway/translate.helper.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";
import type { Case } from "@/core/graph/models/Case.js";
import { AnamnesisCategorySchema } from "@/core/graph/models/Anamnesis.js";
import type { AnamnesisCategory } from "@/core/graph/models/Anamnesis.js";
import { ProcedureNameSchema } from "@/core/graph/models/Procedure.js";
import type { ProcedureName } from "@/core/graph/models/Procedure.js";
import { textPart, type ContentPart } from "@/core/graph/models/ContentPart.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── translate_anamnesis_categories_from_english ──────────────────────────────

const TranslateAnamnesisCategoriesFromEnglishInputSchema = z.object({
  categories: z.array(AnamnesisCategorySchema),
  language: z.string(),
});

/**
 * Category/procedure translation lookups live on the repos, not on the
 * (deliberately minimal) `ProcedureCatalog`/`AnamnesisCatalog` ports from
 * issue 01 — so these two tools are built from the repos directly, closed
 * over at graph-assembly time, rather than reading `runtime.catalogs`.
 */
export function createTranslateAnamnesisCategoriesFromEnglish(
  anamnesisRepo: AnamnesisRepo
): Tool<
  z.infer<typeof TranslateAnamnesisCategoriesFromEnglishInputSchema>,
  Record<AnamnesisCategory, AnamnesisCategory>
> {
  return {
    name: "translate_anamnesis_categories_from_english",
    description:
      "Translate anamnesis category names from English to the target language, using a cache.",
    inputSchema: TranslateAnamnesisCategoriesFromEnglishInputSchema,
    invoke: async ({ categories, language }, runtime, context) => {
      const translations: Record<AnamnesisCategory, AnamnesisCategory> = {};
      const missing: AnamnesisCategory[] = [];

      for (const category of categories) {
        const cached = anamnesisRepo.getAnamnesisCategoryTranslationFromEnglish(
          category,
          language
        );
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
        anamnesisRepo.saveAnamnesisCategoryTranslations(generated, language);
      }

      return translations;
    },
  };
}

// ─── translate_procedure_names_from_english ───────────────────────────────────

const TranslateProcedureNamesFromEnglishInputSchema = z.object({
  procedureNames: z.array(ProcedureNameSchema),
  language: z.string(),
});

export function createTranslateProcedureNamesFromEnglish(
  proceduresRepo: ProceduresRepo
): Tool<
  z.infer<typeof TranslateProcedureNamesFromEnglishInputSchema>,
  Record<ProcedureName, ProcedureName>
> {
  return {
    name: "translate_procedure_names_from_english",
    description:
      "Translate procedure names from English to the target language, using a cache.",
    inputSchema: TranslateProcedureNamesFromEnglishInputSchema,
    invoke: async ({ procedureNames, language }, runtime, context) => {
      const translations: Record<ProcedureName, ProcedureName> = {};
      const missing: ProcedureName[] = [];

      for (const name of procedureNames) {
        const cached = proceduresRepo.getProcedureNameTranslationFromEnglish(
          name,
          language
        );
        if (cached) {
          translations[name] = cached;
        } else {
          missing.push(name);
        }
      }

      if (missing.length > 0) {
        const generated = await generateProceduresFromEnglish(
          runtime,
          missing,
          language,
          context
        );
        Object.assign(translations, generated);
        proceduresRepo.saveProcedureNameTranslation(generated, language);
      }

      return translations;
    },
  };
}

// ─── translate_rest_values (issue 12 §1/§2) ───────────────────────────────────

/**
 * Every `ContentPart[]` field on `Case`, paired with the path prefix its
 * parts are keyed under (see {@link caseAltMap}/{@link applyCaseAltTranslations}
 * below). Index by position, not by name (issue 12 §2) — a procedure name is
 * itself translated by the disjoint defined pass, so keying the rest pass on
 * it would couple the two passes right where the point is that they are
 * disjoint.
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
  c.procedures?.forEach((p, i) => {
    fields.push({ prefix: `procedures.${i}.result`, parts: p.result });
  });

  return fields;
}

/**
 * Build the flat, keyed map of every `ContentPart.alt` in the case — the
 * rest pass's entire input. Keys look like `chiefComplaint.0`,
 * `anamnesis.2.answer.0`, `procedures.1.result.3`. Only `alt` (plain text)
 * ever appears in the map's values — `value` (bytes) never reaches this map,
 * and therefore never reaches the translation prompt built from it.
 */
export function caseAltMap(c: Case): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { prefix, parts } of contentPartFields(c)) {
    parts.forEach((part, i) => {
      map[`${prefix}.${i}`] = part.alt;
    });
  }
  return map;
}

/**
 * Apply a translated `caseAltMap` back onto a case's content-part fields.
 * Per part: a `text/plain` part has `value` **re-derived** as
 * `utf8(translatedAlt)` via `textPart()` — never translated independently,
 * so `alt` and `value` cannot drift. Any other MIME type passes `value`
 * through byte-identical, translating only `alt` — excluded from
 * re-derivation by construction, not by a prompt instruction. A missing key
 * (translation didn't cover it) falls back to the original `alt`/`value`
 * untouched. Part count and order are always preserved (issue 13).
 *
 * Returns only the `ContentPart[]` fields — `patient`, `procedures[].name`,
 * `procedures[].relevance` and `anamnesis[].category` are untouched by this
 * function on purpose; the caller (`translate_merge`) applies
 * `definedTranslations` to the latter two and passes everything else through
 * from the original case.
 */
export function applyCaseAltTranslations(
  c: Case,
  translations: Record<string, string>
): Pick<Case, "chiefComplaint" | "anamnesis" | "procedures"> {
  function translateParts(prefix: string, parts: ContentPart[]): ContentPart[] {
    return parts.map((part, i) => {
      const translatedAlt = translations[`${prefix}.${i}`] ?? part.alt;
      return part.type === "text/plain"
        ? textPart(translatedAlt)
        : { ...part, alt: translatedAlt };
    });
  }

  return {
    ...(c.chiefComplaint && {
      chiefComplaint: translateParts("chiefComplaint", c.chiefComplaint),
    }),
    ...(c.anamnesis && {
      anamnesis: c.anamnesis.map((a, i) => ({
        ...a,
        answer: translateParts(`anamnesis.${i}.answer`, a.answer),
      })),
    }),
    ...(c.procedures && {
      procedures: c.procedures.map((p, i) => ({
        ...p,
        result: translateParts(`procedures.${i}.result`, p.result),
      })),
    }),
  };
}

const TranslateRestValuesInputSchema = z.object({
  values: z.record(z.string(), z.string()),
  language: z.string(),
});

/**
 * One LLM call translating every `ContentPart.alt` in the case, keyed by
 * stable path — see {@link caseAltMap}. Never sent: `value` bytes, procedure
 * names, anamnesis categories, or any enum/identifier/number field (those
 * are either the defined pass's job or pass through untouched — issue 12
 * §1's table).
 */
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

export function createTranslationFromEnglishTools(repos: {
  anamnesis: AnamnesisRepo;
  procedures: ProceduresRepo;
}) {
  return {
    translateAnamnesisCategoriesFromEnglish:
      createTranslateAnamnesisCategoriesFromEnglish(repos.anamnesis),
    translateProcedureNamesFromEnglish:
      createTranslateProcedureNamesFromEnglish(repos.procedures),
    translateRestValues,
  } as const;
}
