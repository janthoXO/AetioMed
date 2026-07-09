import { bus } from "@/core/graph/index.js";
import { retry } from "../utils/retry.js";
import z from "zod";
import {
  getCreativeLLM,
  getDeterministicLLM,
  handleLangchainError,
} from "../utils/llm.js";
import {
  buildPrompt,
  renderForPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import {
  buildProcedureResultSchema,
  buildProcedureSchema,
  ProcedureRelevanceSchema,
  type Procedure,
  type ProcedureName,
  type ProcedureResult,
} from "../models/Procedure.js";
import { getEffectiveProcedureList } from "../03repo/procedures.repo.js";
import type { Patient } from "../models/Patient.js";
import type { Anamnesis } from "../models/Anamnesis.js";
import type { ChiefComplaint } from "../models/ChiefComplaint.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RequestContext } from "../utils/context.js";
import type { ForeignLanguage } from "../models/Language.js";
import { translateTermsKeyed } from "./translate.helper.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

/** The patient's presentation as seen by the blinded solver — no diagnosis. */
export type Presentation = {
  patient?: Patient | undefined;
  chiefComplaint?: ChiefComplaint | undefined;
  anamnesis?: Anamnesis | undefined;
};

export type BlindedProcedureStepResult =
  | {
      action: "procedure";
      procedures?: Procedure[] | undefined;
      reasoning?: string | undefined;
    }
  | {
      action: "diagnose";
      diagnosisName?: string | undefined;
      reasoning?: string | undefined;
    };

// ─── Shared prompt sections ───────────────────────────────────────────────────

function presentationSection(presentation: Presentation) {
  return section("Patient presentation", renderForPrompt(presentation));
}

function approvedProceduresSection(procedures: ProcedureName[] | undefined) {
  return procedures?.length
    ? section(
        "Approved procedure list (RESTRICTED WORKUP)",
        `You MUST ONLY select procedures from the following list, using their exact names. Do not invent or recommend any procedures not explicitly listed below:
${procedures.map((p) => `- ${p}`).join("\n")}`
      )
    : undefined;
}

/**
 * Renders only `name -> result` for each prior procedure. This is used by
 * both the blinded step and the non-blinded bridge step — it deliberately
 * omits `relevance`, which is a judgment relative to the TRUE diagnosis and
 * would leak it to the blinded solver if ever included here.
 */
function previousProceduresSection(previousProcedures: ProcedureResult[]) {
  return section(
    "Procedures ordered so far (with results)",
    previousProcedures.length > 0
      ? previousProcedures
          .map((p, i) => `${i + 1}. ${p.name} -> ${p.result}`)
          .join("\n")
      : "No procedures have been ordered yet."
  );
}

function diagnosisLabel(diagnosis: Diagnosis) {
  return `${diagnosis.name}${diagnosis.icd ? ` (${diagnosis.icd})` : ""}`;
}

function errorFeedback(previousError: Error | undefined) {
  return previousError
    ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
    : "";
}

// ─── 1. generateBlindedProcedureStep ─────────────────────────────────────────

/**
 * The `procedureNames` restriction is applied to the schema used as the
 * grammar constraint, but NOT to the schema rendered into the prompt — the
 * approved list lives in the user message so the system prompt stays stable.
 */
function buildStepSchema(procedureNames?: ProcedureName[]) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("procedure"),
      procedures: z
        .array(buildProcedureSchema(procedureNames))
        .describe("one or more mutually independent procedures to order now"),
      reasoning: z.string().optional().describe("brief clinical reasoning"),
    }),
    z.object({
      action: z.literal("diagnose"),
      diagnosisName: z.string().describe("the diagnosis you commit to"),
      reasoning: z.string().optional().describe("brief clinical reasoning"),
    }),
  ]);
}

/**
 * Blinded step: the solver sees only the patient presentation, prior
 * procedure results, and previously ruled-out diagnoses. It does NOT receive
 * the true diagnosis. It returns either:
 *   • action "procedure" — the next procedure to order (name + relevance), or
 *   • action "diagnose"  — a diagnosis it commits to based on available evidence.
 */
export async function generateBlindedProcedureStep(
  presentation: Presentation,
  previousProcedures: ProcedureResult[],
  ruledOutDiagnoses: string[],
  userInstructions?: string,
  context?: RequestContext
): Promise<BlindedProcedureStepResult> {
  const effectiveProcedures = getEffectiveProcedureList(context?.language);

  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an attending physician working up a patient in a clinical training simulator.
You do NOT know the final diagnosis - reason purely from the patient's presentation and the results of procedures ordered so far.
Your goal: determine the most appropriate next diagnostic action.`
    ),

    section(
      "Rules",
      `Choose ONE action:
- "procedure": Order the next batch of clinically indicated procedures based on the available evidence. You may schedule MULTIPLE procedures together in the same batch, but ONLY if they are mutually independent — none of them interferes with, contraindicates, or depends on the result of another in the batch. If a procedure's indication depends on the result of another procedure you'd also want to order now, leave it for a later iteration instead of batching it.
- "diagnose": Commit to a diagnosis if you have sufficient evidence.

When an approved procedure list is provided, every procedure name MUST be an exact name from that list.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object matching one of these shapes:
${renderSchemaForPrompt(buildStepSchema())}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    approvedProceduresSection(effectiveProcedures),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    ruledOutDiagnoses.length > 0
      ? section(
          "Ruled-out diagnoses",
          `The following diagnoses have already been ruled out — do NOT propose any of these again:
${ruledOutDiagnoses.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
        )
      : undefined,

    `Based on the patient's presentation and the workup so far, what is your next action?`
  );

  console.debug(
    `[GenerateBlindedProcedureStep] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const StepSchema = buildStepSchema(effectiveProcedures);

    const result: BlindedProcedureStepResult = await retry(
      async (attempt, previousError) => {
        const res = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(StepSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(userPrompt + errorFeedback(previousError)),
            ],
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateBlindedProcedureStep] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateBlindedProcedureStep] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return result;
  } catch (error) {
    console.error("[GenerateBlindedProcedureStep] Error:", error);
    throw error;
  }
}

// ─── 2. generateProcedureResults ──────────────────────────────────────────────

const ResultsSchema = z.object({
  procedures: z
    .array(
      z.object({
        name: z
          .string()
          .describe("exact name of a procedure from the ordered batch"),
        relevance: ProcedureRelevanceSchema.describe(
          "Relevance of the procedure to the TRUE diagnosis"
        ),
        result: z.string().describe("clinically realistic result, concise"),
      })
    )
    .describe("one result per procedure ordered in this batch, in any order"),
});

/**
 * Non-blinded result step: given the patient presentation, the TRUE diagnosis,
 * and a batch of concurrently-scheduled procedures, generates a clinically
 * realistic result AND a relevance judgment for each. The blinded solver
 * never knows the true diagnosis, so it cannot meaningfully judge relevance
 * (e.g. it would never knowingly order a "contraindicated" procedure) —
 * both `relevance` and `result` are decided here instead.
 */
export async function generateProcedureResults(
  presentation: Presentation,
  diagnosis: Diagnosis,
  procedureSteps: Procedure[],
  outline?: string,
  userInstructions?: string,
  context?: RequestContext
): Promise<ProcedureResult[]> {
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are a medical simulator generating realistic results for a batch of diagnostic procedures ordered at the same time.
The true diagnosis is known to you. Generate a result AND a relevance judgment for EACH procedure, clinically consistent with both the true diagnosis and the patient's presentation.
These procedures were chosen by a separate, BLINDED solver who does not know the true diagnosis — it ordered them based on the presentation alone, so some may turn out to be unnecessary or even contraindicated in hindsight.`
    ),

    section(
      "Rules",
      `- Provide exactly one result entry per procedure in the batch, using the same "name".
- Each result must be clinically consistent with the true diagnosis.
- Use specific, realistic medical findings (e.g., exact lab values, imaging descriptions).
- Keep each result concise (1–3 sentences).
- Judge "relevance" relative to the TRUE diagnosis, not the blinded solver's reasoning:
  - "obligatory": essential to establishing or confirming this diagnosis.
  - "optional": clinically reasonable and supportive, but not required for this diagnosis.
  - "contraindicated": not indicated, or potentially harmful/misleading, given this diagnosis — even if the blinded solver had a reasonable reason to order it without knowing the diagnosis.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(ResultsSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    outline
      ? section(
          "Case blueprint",
          `Single source of truth — follow its "Workup / Procedure Results Strategy" section, including any difficulty-driven ambiguity or borderline values it specifies:
${outline}`
        )
      : undefined,

    presentationSection(presentation),

    section("True diagnosis", diagnosisLabel(diagnosis)),

    section("Additional instructions", userInstructions),

    section(
      "Procedures ordered together in this batch",
      procedureSteps.map((p, i) => `${i + 1}. ${p.name}`).join("\n")
    ),

    `Generate clinically realistic results for these procedures.`
  );

  console.debug(
    `[GenerateProcedureResults] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const results = await retry(
      async (attempt, previousError) => {
        const res = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(ResultsSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(userPrompt + errorFeedback(previousError)),
            ],
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateProcedureResults] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.procedures;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateProcedureResults] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    // Merge results back onto the input steps, matching by name (falling back
    // to positional index). Both `relevance` and `result` come from this
    // (non-blinded) LLM response — the blinded step never decides relevance.
    return procedureSteps.map((step, index) => {
      const match = results.find((r) => r.name === step.name) ?? results[index];
      return {
        ...step,
        relevance: match?.relevance ?? "optional",
        result: match?.result ?? "",
      };
    });
  } catch (error) {
    console.error("[GenerateProcedureResults] Error:", error);
    throw error;
  }
}

// ─── 3. generateDiagnosisBridge ───────────────────────────────────────────────

/** Same grammar-vs-prompt split as `buildStepSchema`. */
function buildBridgeSchema(procedureNames?: ProcedureName[]) {
  return z.object({
    procedures: z
      .array(buildProcedureResultSchema(procedureNames))
      .describe("bridge procedures that confirm the diagnosis"),
  });
}

/**
 * Non-blinded bridge step: called when the blinded solver has exhausted its
 * iteration budget without reaching the diagnosis. Generates the remaining
 * confirmatory procedures (each with a result) that complete the diagnostic
 * pathway to the true diagnosis.
 */
export async function generateDiagnosisBridge(
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: ProcedureResult[],
  userInstructions?: string,
  context?: RequestContext
): Promise<ProcedureResult[]> {
  const effectiveProcedures = getEffectiveProcedureList(context?.language);

  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert attending physician completing a diagnostic workup for a medical training simulator.
The true diagnosis is known to you. The diagnostic workup so far has not yet confirmed the diagnosis.
Generate the remaining procedures — with clinically consistent results — that efficiently bridge from the current workup to a confirmed diagnosis.`
    ),

    section(
      "Rules",
      `- Generate only the procedures needed to confirm the diagnosis, given what has already been done.
- Each procedure must include a result consistent with the true diagnosis.
- Use specific, professional medical terminology.
- When an approved procedure list is provided, every procedure name MUST be an exact name from that list.
- These are bridge procedures YOU are choosing specifically to confirm the diagnosis, so their "relevance" should almost always be "obligatory" unless one is merely supportive ("optional").`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(buildBridgeSchema())}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    section("True diagnosis", diagnosisLabel(diagnosis)),

    approvedProceduresSection(effectiveProcedures),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    `Generate the remaining bridge procedures to confirm the diagnosis.`
  );

  console.debug(
    `[GenerateDiagnosisBridge] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const BridgeSchema = buildBridgeSchema(effectiveProcedures);

  try {
    const procedures = await retry(
      async (attempt, previousError) => {
        const res = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(BridgeSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(userPrompt + errorFeedback(previousError)),
            ],
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateDiagnosisBridge] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.procedures;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateDiagnosisBridge] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return procedures;
  } catch (error) {
    console.error("[GenerateDiagnosisBridge] Error:", error);
    throw error;
  }
}

// ─── 4. matchDiagnosis ────────────────────────────────────────────────────────

const MatchSchema = z.object({
  matches: z
    .boolean()
    .describe(
      "true if the proposed name refers to the same or an equivalent condition, false otherwise"
    ),
  reasoning: z.string().optional().describe("brief explanation"),
});

/**
 * LLM judge: determines whether a proposed diagnosis name is equivalent to the
 * true diagnosis, accounting for synonyms, alternative names, abbreviations,
 * and specificity differences (e.g. "Type 2 Diabetes" ≡ "Diabetes Mellitus Type 2").
 */
export async function matchDiagnosis(
  proposedName: string,
  diagnosis: Diagnosis,
  context?: RequestContext
): Promise<boolean> {
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are a medical knowledge expert. Determine whether a proposed diagnosis is equivalent to the true diagnosis.
Consider synonyms, alternative names, abbreviations, and different levels of specificity.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(MatchSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section(
      "True diagnosis",
      `${diagnosis.name}${diagnosis.icd ? ` (ICD: ${diagnosis.icd})` : ""}`
    ),

    diagnosis.alternativeNames?.length
      ? section("Alternative names", diagnosis.alternativeNames.join(", "))
      : undefined,

    section("Proposed diagnosis", proposedName)
  );

  console.debug(
    `[MatchDiagnosis] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const matches = await retry(
      async (attempt, previousError) => {
        const res = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(MatchSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(userPrompt + errorFeedback(previousError)),
            ],
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[MatchDiagnosis] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.matches;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[MatchDiagnosis] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        bus.emit("Generation Log", {
          msg,
          logLevel: "error",
          timestamp: new Date().toISOString(),
        });
      }
    );

    return matches;
  } catch (error) {
    console.error("[MatchDiagnosis] Error:", error);
    throw error;
  }
}

export async function generateProceduresFromEnglish(
  procedureNames: string[],
  language: ForeignLanguage,
  context?: RequestContext
): Promise<Record<string, string>> {
  return translateTermsKeyed({
    logTag: "GenerateProceduresFromEnglish",
    taskDescription: `Translate the provided procedures from English to a target language.`,
    contextLines: [`Target language: ${language}`],
    terms: procedureNames,
    context,
  });
}
