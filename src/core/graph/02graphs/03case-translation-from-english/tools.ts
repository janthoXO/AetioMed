import z from "zod";
import { generateAnamnesisCategoriesFromEnglish } from "@/core/graph/03aigateway/anamnesis.aigateway.js";
import { generateProceduresFromEnglish } from "@/core/graph/03aigateway/procedures.aigateway.js";
import { retry } from "@/core/graph/utils/retry.js";
import { GenerationError } from "@/core/graph/errors/AppError.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";
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
  invoke: async (
    { case: caseData, language, generationFlags },
    runtime,
    context
  ) => {
    const systemPrompt = `You are a medical translator.
Your task is to translate the provided medical case JSON content into ${language}.
${generationFlags.includes("procedures") ? "Do NOT translate the procedures relevance field, keep it as is." : ""}
RULES:
1. Preserve the structure exactly.
2. Translate only the VALUES. Do not translate keys.
3. Return ONLY the JSON content, no additional text`;

    const userPrompt = `Case to translate:\n${JSON.stringify(caseData)}`;

    // Deterministic: translation must be faithful, not creative.
    const llm = runtime.llm.for(
      { role: "translator", temperature: "deterministic" },
      context?.llmConfig
    );

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
  language: ForeignLanguageSchema,
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

export function createTranslationFromEnglishTools(repos: {
  anamnesis: AnamnesisRepo;
  procedures: ProceduresRepo;
}) {
  return {
    translateCase,
    translateAnamnesisCategoriesFromEnglish:
      createTranslateAnamnesisCategoriesFromEnglish(repos.anamnesis),
    translateProcedureNamesFromEnglish:
      createTranslateProcedureNamesFromEnglish(repos.procedures),
  } as const;
}
