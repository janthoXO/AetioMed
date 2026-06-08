import z from "zod";
import { generateAnamnesisCategoriesFromEnglish } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import { generateProceduresFromEnglish } from "@/core/graph/03aigateway/procedures.aigateway.js";
import { getLLM } from "@/core/graph/utils/llm.js";
import { retry } from "@/core/graph/utils/retry.js";
import { GenerationError } from "@/core/graph/errors/AppError.js";
import {
  getAnamnesisCategoryTranslationFromEnglish,
  saveAnamnesisCategoryTranslations,
} from "@/core/graph/03repo/anamnesis.repo.js";
import {
  getProcedureNameTranslationFromEnglish,
  saveProcedureNameTranslation,
} from "@/core/graph/03repo/procedures.repo.js";
import { CaseSchema, type Case } from "@/core/graph/models/Case.js";
import { AnamnesisCategorySchema } from "@/core/graph/models/Anamnesis.js";
import type { AnamnesisCategory } from "@/core/graph/models/Anamnesis.js";
import { ProcedureNameSchema } from "@/core/graph/models/Procedure.js";
import type { ProcedureName } from "@/core/graph/models/Procedure.js";
import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import { ForeignLanguageSchema } from "@/core/graph/models/Language.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── translate_case ───────────────────────────────────────────────────────────

const TranslateCaseInputSchema = z.object({
  case: CaseSchema,
  language: ForeignLanguageSchema,
  generationFlags: z.array(GenerationFlagSchema),
});

export const translateCase: Tool<
  z.infer<typeof TranslateCaseInputSchema>,
  Case
> = {
  name: "translate_case",
  description:
    "Translate all value fields in a generated medical case to the target language.",
  inputSchema: TranslateCaseInputSchema,
  invoke: async ({ case: caseData, language, generationFlags }, context) => {
    const systemPrompt = `You are a medical translator.
Your task is to translate the provided medical case JSON content into ${language}.
${generationFlags.includes("procedures") ? "Do NOT translate the procedures relevance field, keep it as is." : ""}
RULES:
1. Preserve the structure exactly.
2. Translate only the VALUES. Do not translate keys.
3. Return ONLY the JSON content, no additional text`;

    const userPrompt = `Case to translate:\n${JSON.stringify(caseData)}`;

    const llm = getLLM(context?.llmConfig);

    return retry(
      async () => {
        try {
          return await llm
            .withStructuredOutput(CaseSchema)
            .invoke([
              new SystemMessage(systemPrompt),
              new HumanMessage(userPrompt),
            ]);
        } catch {
          throw new GenerationError(
            "Failed to parse LLM response in JSON format"
          );
        }
      },
      2,
      0
    );
  },
};

// ─── translate_anamnesis_categories_from_english ──────────────────────────────

const TranslateAnamnesisCategoriesFromEnglishInputSchema = z.object({
  categories: z.array(AnamnesisCategorySchema),
  language: ForeignLanguageSchema,
});

export const translateAnamnesisCategoriesFromEnglish: Tool<
  z.infer<typeof TranslateAnamnesisCategoriesFromEnglishInputSchema>,
  Record<AnamnesisCategory, AnamnesisCategory>
> = {
  name: "translate_anamnesis_categories_from_english",
  description:
    "Translate anamnesis category names from English to the target language, using a cache.",
  inputSchema: TranslateAnamnesisCategoriesFromEnglishInputSchema,
  invoke: async ({ categories, language }, context) => {
    const translations: Record<AnamnesisCategory, AnamnesisCategory> = {};
    const missing: AnamnesisCategory[] = [];

    for (const category of categories) {
      const cached = getAnamnesisCategoryTranslationFromEnglish(
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
        missing,
        language,
        context
      );
      Object.assign(translations, generated);
      saveAnamnesisCategoryTranslations(generated, language);
    }

    return translations;
  },
};

// ─── translate_procedure_names_from_english ───────────────────────────────────

const TranslateProcedureNamesFromEnglishInputSchema = z.object({
  procedureNames: z.array(ProcedureNameSchema),
  language: ForeignLanguageSchema,
});

export const translateProcedureNamesFromEnglish: Tool<
  z.infer<typeof TranslateProcedureNamesFromEnglishInputSchema>,
  Record<ProcedureName, ProcedureName>
> = {
  name: "translate_procedure_names_from_english",
  description:
    "Translate procedure names from English to the target language, using a cache.",
  inputSchema: TranslateProcedureNamesFromEnglishInputSchema,
  invoke: async ({ procedureNames, language }, context) => {
    const translations: Record<ProcedureName, ProcedureName> = {};
    const missing: ProcedureName[] = [];

    for (const name of procedureNames) {
      const cached = getProcedureNameTranslationFromEnglish(name, language);
      if (cached) {
        translations[name] = cached;
      } else {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      const generated = await generateProceduresFromEnglish(
        missing,
        language,
        context
      );
      Object.assign(translations, generated);
      saveProcedureNameTranslation(generated, language);
    }

    return translations;
  },
};

export const translationFromEnglishTools = {
  translateCase,
  translateAnamnesisCategoriesFromEnglish,
  translateProcedureNamesFromEnglish,
} as const;
