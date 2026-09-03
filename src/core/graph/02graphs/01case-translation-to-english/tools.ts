import z from "zod";
import { generateDiagnosisToEnglish } from "@/core/graph/03aigateway/diagnosis.aigateway.js";
import {
  getDiagnosisTranslationToEnglish,
  saveDiagnosisTranslations,
} from "@/core/graph/03repo/diagnosis.repo.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import { ForeignLanguageSchema } from "@/core/graph/models/Language.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const TranslateDiagnosisInputSchema = z.object({
  diagnosis: DiagnosisSchema,
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

export const translationToEnglishTools = {
  translateDiagnosisToEnglish,
} as const;
