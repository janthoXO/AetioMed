import z from "zod";
import type {
  Diagnosis,
  ICDCode,
} from "@/core/graph/shared/domain/Diagnosis.js";
import {
  promptLanguage,
  type Language,
} from "@/core/graph/shared/domain/Language.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import {
  getRequestContext,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
} from "@/core/graph/shared/prompt/prompt.js";
import { AppError } from "@/core/graph/errors/AppError.js";
import type { IcdPort, IcdSearchHit } from "./icd.js";

/** The request names no diagnosis this deployment can resolve. */
export class UnknownDiagnosisError extends AppError {
  constructor(message: string) {
    super(message, "INVALID_REQUEST_BODY", 400);
  }
}

/**
 * The request's diagnosis as the English `Diagnosis` generation runs on
 * (#237). Runs before the graph, inside `runWithContext`.
 *
 * ICD configured: everything goes through ICD. `icd` wins over `name`. A
 * name must hit an ICD title or synonym exactly, in the request language or,
 * LLM-translated, in English. Never a fuzzy best match: that would silently
 * swap the teaching diagnosis ("Diabetes" must not become "Type 1 diabetes
 * mellitus").
 *
 * No ICD: the name goes to English through the translation store
 * (`diagnosisTranslations.yml` prefill), LLM on a miss; `icd` passes through
 * as an opaque tag (it still keys the symptom basis).
 */
export async function resolveDiagnosis(
  deps: { icd: IcdPort | undefined; runtime: GraphRuntime },
  req: { icd?: ICDCode | undefined; name?: string | undefined },
  language: Language
): Promise<Diagnosis> {
  const { icd, runtime } = deps;
  const name = req.name?.trim() || undefined;
  const context = getRequestContext();
  const signal = context?.signal;

  if (!icd) {
    if (!name) {
      throw new UnknownDiagnosisError(
        "A diagnosis name is required when no ICD API is configured"
      );
    }
    return {
      name: await nameToEnglish(runtime, name, language, context),
      icd: req.icd,
    };
  }

  let code = req.icd;
  if (!code && name) {
    code = exactHit(await icd.search(name, language, signal), name);
    if (!code && language !== "en") {
      const english = await translateToEnglish(
        runtime,
        name,
        language,
        context
      );
      code = exactHit(await icd.search(english, "en", signal), english);
    }
    if (!code) {
      throw new UnknownDiagnosisError(`No ICD-11 diagnosis is named "${name}"`);
    }
  }
  if (!code) {
    throw new UnknownDiagnosisError("Either 'icd' or 'diagnosis' is required");
  }

  const entity = await icd.entity(code, "en", signal);
  if (!entity) throw new UnknownDiagnosisError(`Unknown ICD-11 code ${code}`);
  return { name: entity.title, icd: code };
}

/** Case-, whitespace- and Unicode-form-insensitive. */
function normalize(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** First hit whose title or a matched synonym equals `name`. */
function exactHit(hits: IcdSearchHit[], name: string): ICDCode | undefined {
  const wanted = normalize(name);
  return hits.find((hit) =>
    [hit.title, ...hit.synonyms].some((label) => normalize(label) === wanted)
  )?.code;
}

/** No-ICD path: store first (curated YAML / earlier LLM answer), LLM on a miss. */
async function nameToEnglish(
  runtime: GraphRuntime,
  name: string,
  language: Language,
  context: RequestContext | undefined
): Promise<string> {
  if (language === "en") return name;
  const cached = runtime.catalogs.diagnosis.toEnglish(name, language);
  if (cached) return cached;
  const english = await translateToEnglish(runtime, name, language, context);
  runtime.catalogs.diagnosis.saveTranslations({ [english]: name }, language);
  return english;
}

const responseSchema = z.object({
  diagnosis: z.string().describe("the diagnosis translated to English"),
});

async function translateToEnglish(
  runtime: GraphRuntime,
  name: string,
  language: Language,
  context: RequestContext | undefined
): Promise<string> {
  // Translator call, target always English: no language directive.
  const system = buildPrompt(
    section(
      "Role",
      "Translate the provided diagnosis from the provided language to English."
    ),
    section(
      "Output format",
      `Return ONLY a valid JSON object:\n${renderSchemaForPrompt(responseSchema)}`
    )
  );
  const user = buildPrompt(
    section("Source language", promptLanguage(language)),
    section("Target language", promptLanguage("en")),
    section("Diagnosis to translate", name)
  );
  const response = await runtime.llm.structured(
    { role: "translator", temperature: "deterministic" },
    { system, user },
    responseSchema,
    context
  );
  return response.diagnosis;
}
