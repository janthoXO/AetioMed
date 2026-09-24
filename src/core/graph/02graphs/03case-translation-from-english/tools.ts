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

/** Translation lookups live on repos, not the minimal `ProcedureCatalog`/`AnamnesisCatalog` ports; tools built from repos, closed over at assembly time. */
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

// ─── translate_rest_values ────────────────────────────────────────────────────

/** Every `ContentPart[]` field on `Case` with its path prefix (see {@link caseTextMap}/{@link applyCaseTextTranslations}). Index by position, not name: names are translated by the defined pass; keying on them would couple the passes. */
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
 * Returns only `ContentPart[]` fields; `patient`, `procedures[].name`/`relevance`, `anamnesis[].category` untouched (caller applies `definedTranslations`, passes rest through).
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
