import { getDeterministicLLM } from "@/utils/llm.js";
import { type Procedure } from "@/02domain-models/Procedure.js";
import { retry } from "@/utils/retry.js";
import path from "node:path";
import YAML from "yaml";
import fs from "fs";
import z from "zod";
import type { Language } from "@/02domain-models/Language.js";

const LanguageProcedureTranslationSchema = z.partialRecord(
  z.enum(["English", "German"]),
  z.record(z.string(), z.string())
);

type LanguageProcedureTranslationMapping = z.infer<
  typeof LanguageProcedureTranslationSchema
>;

function preloadProcedureTranslations(): LanguageProcedureTranslationMapping {
  const filepath = path.resolve(
    import.meta.dirname,
    "../../data/proceduresTranslations.yml"
  );

  const translationsObject = YAML.parse(fs.readFileSync(filepath, "utf-8"));

  const parseResult =
    LanguageProcedureTranslationSchema.safeParse(translationsObject);
  if (!parseResult.success) {
    console.error(
      "Error parsing procedure translations YAML:",
      parseResult.error
    );
    return {}; // Return empty object on parsing failure
  }

  console.info(
    "[Procedures] Loaded procedure translations from YAML:",
    parseResult.data
  );
  return parseResult.data;
}

/**
 * Mapping of procedure translations from English to other languages
 *
 * e.g. { German: { "Blood Test": "Bluttest", ... } }
 */
const ProcedureTranslations: LanguageProcedureTranslationMapping =
  preloadProcedureTranslations();

/**
 * Get the translation of a procedure from English to the target language
 * @param category
 * @param language
 * @returns
 */
function getProcedureTranslationFromEnglish(
  procedure: Procedure,
  language: Language
): Procedure | undefined {
  const translatedName = ProcedureTranslations[language]?.[procedure.name];
  if (translatedName) {
    return { name: translatedName };
  }

  return undefined;
}

async function generateProceduresFromEnglish(
  procedures: Procedure[],
  language: Language
): Promise<(Procedure | undefined)[]> {
  const systemPrompt = `Translate the provided procedures from English to a target language:
  
Return the procedures mapped to their translated part in a JSON
{
  "provided procedure1": "translated procedure1",
  "provided procedure2": "translated procedure2",
  ...
}
ONLY return the JSON object, no additional text.`;

  const userPrompt = `Target language: ${language}
Procedures to translate:
${procedures.map((p) => p.name.toLowerCase()).join("\n")}`;

  console.debug(
    `[Procedures Service] Generating procedure translations with prompt: 
  ${systemPrompt}
  ${userPrompt}`
  );

  const prompt = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const parsed = await retry(
    async () => {
      const response = await getDeterministicLLM().invoke(prompt);

      console.debug(
        "[Procedures Service] Generated procedure translations:",
        response.text
      );

      const responseSchema = z.record(z.string(), z.string());
      return responseSchema.parse(JSON.parse(response.text));
    },
    2,
    0
  );

  // Filter only the requested procedures
  const sortedTranslation: (Procedure | undefined)[] = procedures.map(
    () => undefined
  );
  for (const [original, translated] of Object.entries(parsed)) {
    const index = procedures
      .map((p) => p.name.toLowerCase())
      .indexOf(original.toLowerCase());
    if (index === -1) {
      continue; // keep the original procedure if no translation was provided
      // throw new Error(
      //   `The procedure "${original}" was not in the list of procedures to translate.`
      // );
    }
    sortedTranslation[index] = { name: translated };
  }

  return sortedTranslation;
}

export async function translateProceduresFromEnglish(
  procedures: Procedure[],
  language: Language
): Promise<Procedure[]> {
  const translations: Procedure[] = [];
  const failedTranslations: { index: number; procedure: Procedure }[] = [];
  for (let i = 0; i < procedures.length; i++) {
    const englishProcedure = getProcedureTranslationFromEnglish(
      procedures[i]!,
      language
    );

    if (englishProcedure) {
      translations[i] = englishProcedure;
    } else {
      failedTranslations.push({ index: i, procedure: procedures[i]! });
    }
  }

  if (failedTranslations.length > 0) {
    const englishProcedures = await generateProceduresFromEnglish(
      failedTranslations.map((t) => t.procedure),
      language
    );

    for (const { index, procedure } of failedTranslations) {
      // add to translations
      translations[index] = englishProcedures[index] ?? procedure;

      // save the translation to the memory cache for future use (only if translation successful)
      if (englishProcedures[index]) {
        if (!ProcedureTranslations[language]) {
          ProcedureTranslations[language] = {};
        }
        ProcedureTranslations[language][englishProcedures[index].name] =
          procedure.name;
      }
    }
  }

  return translations;
}
