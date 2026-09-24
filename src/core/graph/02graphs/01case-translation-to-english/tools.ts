import z from "zod";
import { generateDiagnosisToEnglish } from "@/core/graph/03aigateway/diagnosis.aigateway.js";
import { translateRecordKeyed } from "@/core/graph/03aigateway/translate.helper.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";
import type { UserInstructions } from "@/core/graph/models/UserInstructions.js";
import type { Tool } from "@/core/graph/utils/tool.js";

// `language` plain `string`: supported set is deployment config, validated at API boundary (`api/CaseGenerationRequest.ts`).
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

// ─── translate_user_instructions_to_english  ─────────────────────

const TranslateUserInstructionsInputSchema = z.object({
  userInstructions: UserInstructionsSchema,
  language: z.string(),
});

/** Free text, no catalogue or cache: translated afresh each call. Keyed by instruction keys (flag names / `"general"`), not text; two slots can hold same text. */
export const translateUserInstructionsToEnglish: Tool<
  z.infer<typeof TranslateUserInstructionsInputSchema>,
  UserInstructions
> = {
  name: "translate_user_instructions_to_english",
  description: "Translate free-text user instructions to English.",
  inputSchema: TranslateUserInstructionsInputSchema,
  invoke: async ({ userInstructions, language }, runtime, context) =>
    translateRecordKeyed(runtime, {
      logTag: "TranslateUserInstructionsToEnglish",
      taskDescription:
        "Translate the provided free-text user instructions from the given language to English.",
      contextLines: [
        `Source language: ${language}`,
        `Target language: English`,
      ],
      values: userInstructions,
      context,
    }),
};

export const translationToEnglishTools = {
  translateDiagnosisToEnglish,
  translateUserInstructionsToEnglish,
} as const;
