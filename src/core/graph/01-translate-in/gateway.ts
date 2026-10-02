import z from "zod";
import type { ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
} from "@/core/graph/shared/prompt/prompt.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { translateRecordKeyed } from "@/core/graph/shared/translation/translate.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import type { UserInstructions } from "@/core/graph/shared/domain/UserInstructions.js";

const responseSchema = z.object({
  diagnosis: z.string().describe("the diagnosis translated to English"),
});

export async function generateDiagnosisToEnglish(
  runtime: GraphRuntime,
  diagnosis: string,
  language: ForeignLanguage,
  context?: RequestContext
): Promise<string> {
  // `buildPrompt`, not `buildSystemPrompt`: translator call, target always
  // English; language directive (foreign target only) never applies.
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `Translate the provided diagnosis from the provided language to English.`
    ),
    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(responseSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Source language", language),
    section("Target language", "English"),
    section("Diagnosis to translate", diagnosis)
  );

  console.debug(
    `[GenerateDiagnosisToEnglish] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const response = await runtime.llm.structured(
    { role: "translator", temperature: "deterministic" },
    { system: systemPrompt, user: userPrompt },
    responseSchema,
    context
  );

  console.debug(
    `[GenerateDiagnosisToEnglish] Generated diagnosis translation:\n${response.diagnosis}`
  );

  return response.diagnosis;
}

// `language` plain `string`: supported set is deployment config, validated at API boundary (`api/CaseGenerationRequest.ts`).
export async function translateDiagnosisToEnglish(
  runtime: GraphRuntime,
  input: { diagnosis: Diagnosis; language: string },
  context?: RequestContext
): Promise<Diagnosis> {
  const { diagnosis, language } = input;
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
}

// ─── translate_user_instructions_to_english  ─────────────────────

/** Free text, no catalogue or cache: translated afresh each call. Keyed by instruction keys (flag names / `"general"`), not text; two slots can hold same text. */
export async function translateUserInstructionsToEnglish(
  runtime: GraphRuntime,
  input: { userInstructions: UserInstructions; language: string },
  context?: RequestContext
): Promise<UserInstructions> {
  const { userInstructions, language } = input;
  return translateRecordKeyed(runtime, {
    logTag: "TranslateUserInstructionsToEnglish",
    taskDescription:
      "Translate the provided free-text user instructions from the given language to English.",
    contextLines: [`Source language: ${language}`, `Target language: English`],
    values: userInstructions,
    context,
  });
}
