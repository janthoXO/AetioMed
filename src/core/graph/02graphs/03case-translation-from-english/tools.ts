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
import {
  ProcedureNameSchema,
  ProcedureRelevanceSchema,
} from "@/core/graph/models/Procedure.js";
import type { ProcedureName } from "@/core/graph/models/Procedure.js";
import { PatientSchema } from "@/core/graph/models/Patient.js";
import { textOf, textPart } from "@/core/graph/models/ContentPart.js";
import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { Tool } from "@/core/graph/utils/tool.js";

// ─── translate_case ───────────────────────────────────────────────────────────

const TranslateCaseInputSchema = z.object({
  case: CaseSchema,
  language: z.string(),
  generationFlags: z.array(GenerationFlagSchema),
});

/**
 * LLM-facing translation shape (issue 11 §6): the same fields as `Case`,
 * but the three `ContentPart[]` fields collapsed to plain strings via
 * `textOf` before the case ever reaches this tool's prompt, and rebuilt
 * with `textPart()` from the translated strings afterwards. `value` (bytes)
 * never reaches the translator; only `alt` text does.
 *
 * NOTE (issue 12): this still translates the WHOLE case in one LLM call,
 * and that response overwrites — via the state's shallow-merge reducer —
 * the anamnesis-category / procedure-name translations already produced by
 * the deterministic, cache-backed translators upstream
 * (`translate_anamnesis_category`, `translate_procedures_names`). That is a
 * real bug: the controlled vocabulary is silently overwritten by free-text
 * LLM output. It is preserved here on purpose — fixing it is issue 12's job
 * (disjoint defined/rest passes plus an explicit merge), and fixing it here
 * would make any quality regression unattributable between two changes.
 *
 * NOTE (issue 13): multi-part fields do not exist yet — every field has
 * exactly one part today. If that ever changes while this projection is
 * still in place, `textOf`'s join collapses the parts into one string
 * before translation; this code must be retired (by issue 12) before a
 * field can have more than one part.
 */
const TranslatableCaseSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: z.string().optional(),
  anamnesis: z
    .array(z.object({ category: z.string(), answer: z.string() }))
    .optional(),
  procedures: z
    .array(
      z.object({
        name: z.string(),
        relevance: ProcedureRelevanceSchema,
        result: z.string(),
      })
    )
    .optional(),
});
type TranslatableCase = z.infer<typeof TranslatableCaseSchema>;

/** Project a domain `Case` to the text-only shape the translator sees. */
function projectCaseToText(c: Case): TranslatableCase {
  return {
    ...(c.patient !== undefined && { patient: c.patient }),
    ...(c.chiefComplaint !== undefined && {
      chiefComplaint: textOf(c.chiefComplaint),
    }),
    ...(c.anamnesis !== undefined && {
      anamnesis: c.anamnesis.map((a) => ({
        category: a.category,
        answer: textOf(a.answer),
      })),
    }),
    ...(c.procedures !== undefined && {
      procedures: c.procedures.map((p) => ({
        name: p.name,
        relevance: p.relevance,
        result: textOf(p.result),
      })),
    }),
  };
}

/** Rebuild a domain `Case` from the translator's text-only response. */
function reconstructCase(t: TranslatableCase): Case {
  return {
    ...(t.patient !== undefined && { patient: t.patient }),
    ...(t.chiefComplaint !== undefined && {
      chiefComplaint: [textPart(t.chiefComplaint)],
    }),
    ...(t.anamnesis !== undefined && {
      anamnesis: t.anamnesis.map((a) => ({
        category: a.category,
        answer: [textPart(a.answer)],
      })),
    }),
    ...(t.procedures !== undefined && {
      procedures: t.procedures.map((p) => ({
        name: p.name,
        relevance: p.relevance,
        result: [textPart(p.result)],
      })),
    }),
  };
}

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

    const projectedCase = projectCaseToText(caseData);
    const userPrompt = `Case to translate:\n${JSON.stringify(projectedCase)}`;

    // Deterministic: translation must be faithful, not creative.
    const llm = runtime.llm.for(
      { role: "translator", temperature: "deterministic" },
      context?.llmConfig
    );

    const translated = await retry(
      async () => {
        try {
          return await llm
            .withStructuredOutput(TranslatableCaseSchema)
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

    return reconstructCase(translated);
  },
};

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
