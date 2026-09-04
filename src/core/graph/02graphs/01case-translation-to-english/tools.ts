import z from "zod";
import { generateDiagnosisToEnglish } from "@/core/graph/03aigateway/diagnosis.aigateway.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// `language` is a plain `string` (issue 09 §1): the supported set is
// deployment configuration, validated once at the API boundary
// (`api/CaseGenerationRequest.ts`), not re-validated here.
const TranslateDiagnosisInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  language: z.string(),
});

export const translateDiagnosisToEnglish: Tool<
  z.infer<typeof TranslateDiagnosisInputSchema>,
  Diagnosis
> = {
  name: "translate_diagnosis_to_english",
  description:
    "Translate a diagnosis name to English, using a cache for known translations.",
  inputSchema: TranslateDiagnosisInputSchema,
  invoke: async ({ diagnosis, language }, runtime, context) => {
    let englishName = runtime.catalogs.diagnosis.toEnglish(
      diagnosis.name,
      language
    );
    if (!englishName) {
      englishName = await generateDiagnosisToEnglish(
        runtime,
        diagnosis.name,
        language,
        context
      );
      runtime.catalogs.diagnosis.saveTranslations(
        { [englishName]: diagnosis.name },
        language
      );
    }
    return { ...diagnosis, name: englishName };
  },
};

export const translationToEnglishTools = {
  translateDiagnosisToEnglish,
} as const;
