import z from "zod";
import { generateDiagnosisToEnglish } from "@/core/graph/03aigateway/diagnosis.aigateway.js";
import { translateRecordKeyed } from "@/core/graph/03aigateway/translate.helper.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import type { Diagnosis } from "@/core/graph/models/Diagnosis.js";
import { UserInstructionsSchema } from "@/core/graph/models/UserInstructions.js";
import type { UserInstructions } from "@/core/graph/models/UserInstructions.js";
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

// ─── translate_user_instructions_to_english (issue 12 §3) ─────────────────────

const TranslateUserInstructionsInputSchema = z.object({
  userInstructions: UserInstructionsSchema,
  language: z.string(),
});

/**
 * Free-text, per-request instructions have no catalogue and no cache — every
 * call translates afresh. Keyed by the instructions' own keys (generation
 * flag names / `"general"`), not by their text, since two instruction slots
 * can legitimately hold the same text.
 */
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
