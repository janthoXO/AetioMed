import z from "zod";
import { generateDiagnosisToEnglish } from "@/core/graph/03aigateway/diagnosis.aigateway.js";
import { generateAnamnesisCategoriesToEnglish } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import {
  getDiagnosisTranslationToEnglish,
  saveDiagnosisTranslations,
} from "@/core/graph/03repo/diagnosis.repo.js";
import {
  getAnamnesisCategoryTranslationToEnglish,
  saveAnamnesisCategoryTranslations,
} from "@/core/graph/03repo/anamnesis.repo.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import { AnamnesisCategorySchema } from "@/core/graph/models/Anamnesis.js";
import type { AnamnesisCategory } from "@/core/graph/models/Anamnesis.js";
import { ForeignLanguageSchema } from "@/core/graph/models/Language.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const TranslateDiagnosisInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  language: ForeignLanguageSchema,
});

const TranslateAnamnesisCategoriesToEnglishInputSchema = z.object({
  categories: z.array(AnamnesisCategorySchema),
  language: ForeignLanguageSchema,
});

export const translateDiagnosisToEnglish: Tool<
  z.infer<typeof TranslateDiagnosisInputSchema>,
  Diagnosis
> = {
  name: "translate_diagnosis_to_english",
  description:
    "Translate a diagnosis name to English, using a cache for known translations.",
  inputSchema: TranslateDiagnosisInputSchema,
  invoke: async ({ diagnosis, language }, context) => {
    let englishName = getDiagnosisTranslationToEnglish(
      diagnosis.name,
      language
    );
    if (!englishName) {
      englishName = await generateDiagnosisToEnglish(
        diagnosis.name,
        language,
        context
      );
      saveDiagnosisTranslations({ [englishName]: diagnosis.name }, language);
    }
    return { ...diagnosis, name: englishName };
  },
};

export const translateAnamnesisCategoriesToEnglish: Tool<
  z.infer<typeof TranslateAnamnesisCategoriesToEnglishInputSchema>,
  Record<AnamnesisCategory, AnamnesisCategory>
> = {
  name: "translate_anamnesis_categories_to_english",
  description:
    "Translate anamnesis category names to English, using a cache for known translations.",
  inputSchema: TranslateAnamnesisCategoriesToEnglishInputSchema,
  invoke: async ({ categories, language }, context) => {
    const translations: Record<AnamnesisCategory, AnamnesisCategory> = {};
    const missing: AnamnesisCategory[] = [];

    for (const category of categories) {
      const cached = getAnamnesisCategoryTranslationToEnglish(
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
      const generated = await generateAnamnesisCategoriesToEnglish(
        missing,
        language,
        context
      );
      Object.assign(translations, generated);
      saveAnamnesisCategoryTranslations(
        Object.fromEntries(
          Object.entries(generated).map(([translated, eng]) => [
            eng,
            translated,
          ])
        ),
        language
      );
    }

    return translations;
  },
};

export const translationToEnglishTools = {
  translateDiagnosisToEnglish,
  translateAnamnesisCategoriesToEnglish,
} as const;
