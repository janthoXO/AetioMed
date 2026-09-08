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
 * parts are keyed under (see {@link caseTextMap}/{@link applyCaseTextTranslations}
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
 * Build the flat, keyed map of every `ContentPart` text fragment in the
 * case — the rest pass's entire input. Keys look like `chiefComplaint.0.alt`,
 * `anamnesis.2.answer.0.text`, `procedures.1.result.3.alt`.
 *
 * Two keys per part now that `alt` and `value` carry independent text
 * (issue 21 §2): every part contributes an `.alt` entry (its short label),
 * and a `text/*` part additionally contributes a `.text` entry (its
 * decoded prose, via `textOfPart`) — a non-text part's `value` is bytes and
 * never reaches this map, so it has no `.text` entry. Only these strings
 * ever appear in the map's values; bytes never reach the translation prompt
 * built from it.
 *
 * Today `alt` and the decoded text are equal for every text part (both
 * generators still set `alt` to the same string they render into `value`),
 * so the `.alt` and `.text` entries for a given text part carry the same
 * value and get translated to the same output. That duplication is expected
 * at this step, not a bug to optimise away — a planner-authored `alt` that
 * genuinely differs from the rendered prose (issue 21 §5) is what makes the
 * two keys diverge.
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
 * Apply a translated `caseTextMap` back onto a case's content-part fields.
 * Per part: a `text/plain` part takes its translated `.text` entry into
 * `value` (via `encodeText`) and its translated `.alt` entry into `alt` —
 * the two are translated, and applied, independently, since they are no
 * longer derived from one another. Any other MIME type passes `value`
 * through byte-identical, translating only `alt`. A missing key (translation
 * didn't cover it) falls back to the original `alt`/`value` untouched. Part
 * count and order are always preserved (issue 13).
 *
 * Returns only the `ContentPart[]` fields — `patient`, `procedures[].name`,
 * `procedures[].relevance` and `anamnesis[].category` are untouched by this
 * function on purpose; the caller (`translate_merge`) applies
 * `definedTranslations` to the latter two and passes everything else through
 * from the original case.
 */
export function applyCaseTextTranslations(
  c: Case,
  translations: Record<string, string>
): Pick<Case, "chiefComplaint" | "anamnesis" | "procedures"> {
  function translateParts(prefix: string, parts: ContentPart[]): ContentPart[] {
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
 * One LLM call translating every `ContentPart` text fragment in the case
 * (both its `alt` label and, for text parts, its decoded prose), keyed by
 * stable path — see {@link caseTextMap}. Never sent: `value` bytes, procedure
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
