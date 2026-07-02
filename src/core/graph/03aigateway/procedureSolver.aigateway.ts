import { bus } from "@/core/graph/index.js";
import { retry } from "../utils/retry.js";
import z from "zod";
import {
  buildPrompt,
  getCreativeLLM,
  getDeterministicLLM,
  handleLangchainError,
} from "../utils/llm.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import {
  buildProcedureSchema,
  buildProcedureStepSchema,
  getEffectiveProcedureList,
  type Procedure,
  type ProcedureName,
  type ProcedureStep,
} from "../models/Procedure.js";
import type { Patient } from "../models/Patient.js";
import type { Anamnesis } from "../models/Anamnesis.js";
import type { ChiefComplaint } from "../models/ChiefComplaint.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RequestContext } from "../utils/context.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

/** The patient's presentation as seen by the blinded solver — no diagnosis. */
export type Presentation = {
  patient?: Patient | undefined;
  chiefComplaint?: ChiefComplaint | undefined;
  anamnesis?: Anamnesis | undefined;
};

export type BlindedProcedureStepResult = {
  action: "procedure" | "diagnose";
  procedure?: ProcedureStep | undefined;
  diagnosisName?: string | undefined;
  reasoning?: string | undefined;
};

// ─── 1. generateBlindedProcedureStep ─────────────────────────────────────────

/**
 * Blinded step: the solver sees only the patient presentation, prior
 * procedure results, and previously ruled-out diagnoses. It does NOT receive
 * the true diagnosis. It returns either:
 *   • action "procedure" — the next procedure to order (name + relevance), or
 *   • action "diagnose"  — a diagnosis it commits to based on available evidence.
 */
export async function generateBlindedProcedureStep(
  presentation: Presentation,
  previousProcedures: Procedure[],
  ruledOutDiagnoses: string[],
  procedureNameList?: ProcedureName[],
  userInstructions?: string,
  context?: RequestContext
): Promise<BlindedProcedureStepResult> {
  const effectiveProcedures =
    procedureNameList ?? getEffectiveProcedureList(context?.language);

  const systemPrompt = buildPrompt(
    `You are an attending physician working up a patient in a clinical training simulator.
You do NOT know the final diagnosis — reason purely from the patient's presentation and the results of procedures ordered so far.
Your goal: determine the most appropriate next diagnostic action.`,

    `Patient presentation:
${JSON.stringify(presentation, null, 2)}`,

    previousProcedures.length > 0
      ? `Procedures ordered so far (with results):
${previousProcedures.map((p, i) => `${i + 1}. ${p.name} → ${p.result}`).join("\n")}`
      : `No procedures have been ordered yet.`,

    ruledOutDiagnoses.length > 0
      ? `Diagnoses already ruled out — do NOT propose any of these again:
${ruledOutDiagnoses.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
      : undefined,

    effectiveProcedures?.length
      ? `[RESTRICTED WORKUP]
You MUST ONLY select procedures from the following approved list. Do not invent or recommend any procedures not explicitly listed below:
${effectiveProcedures.map((p) => `- ${p}`).join("\n")}`
      : undefined,

    `Choose ONE action:
- "procedure": Order the single most clinically indicated next procedure based on the available evidence.
- "diagnose": Commit to a diagnosis if you have sufficient evidence.

Return a JSON object with:
  "action": "procedure" | "diagnose"
  "procedure": { name, relevance } — required when action is "procedure"; omit otherwise.
  "diagnosisName": string — required when action is "diagnose"; omit otherwise.
  "reasoning": brief clinical reasoning (optional).
Return ONLY the JSON object, no additional text.`,

    userInstructions ? `Additional instructions: ${userInstructions}` : undefined
  );

  const userPrompt = `Based on the patient's presentation and the workup so far, what is your next action?`;

  console.debug(
    `[GenerateBlindedProcedureStep] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const StepSchema = z.object({
      action: z.enum(["procedure", "diagnose"]),
      procedure: buildProcedureStepSchema(effectiveProcedures).optional(),
      diagnosisName: z.string().optional(),
      reasoning: z.string().optional(),
    });

    const result: BlindedProcedureStepResult = await retry(
      async (attempt, previousError) => {
        const res = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(StepSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(
                userPrompt +
                  (previousError
                    ? `\nPrevious generation error: ${previousError.message}`
                    : "")
              ),
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

// ─── 2. generateProcedureResult ───────────────────────────────────────────────

/**
 * Non-blinded result step: given the patient presentation, the TRUE diagnosis,
 * and the chosen procedure, generates a clinically realistic result consistent
 * with the diagnosis.
 */
export async function generateProcedureResult(
  presentation: Presentation,
  diagnosis: Diagnosis,
  procedureStep: ProcedureStep,
  outline?: string,
  userInstructions?: string,
  context?: RequestContext
): Promise<string> {
  const systemPrompt = buildPrompt(
    `You are a medical simulator generating a realistic result for a diagnostic procedure.
The true diagnosis is known to you. Generate a result that is clinically consistent with both the true diagnosis and the patient's presentation.`,

    outline
      ? `Case blueprint (single source of truth — follow its "Workup / Procedure Results Strategy" section, including any difficulty-driven ambiguity or borderline values it specifies):
${outline}`
      : undefined,

    `Patient presentation:
${JSON.stringify(presentation, null, 2)}`,

    `True diagnosis: ${diagnosis.name}${diagnosis.icd ? ` (${diagnosis.icd})` : ""}`,

    `Procedure: ${procedureStep.name}`,

    `Requirements:
- The result must be clinically consistent with the true diagnosis.
- Use specific, realistic medical findings (e.g., exact lab values, imaging descriptions).
- Keep it concise (1–3 sentences).
- Return ONLY the JSON object with a single "result" field, no additional text.`,

    userInstructions ? `Additional instructions: ${userInstructions}` : undefined
  );

  const userPrompt = `Generate a clinically realistic result for the procedure: ${procedureStep.name}`;

  console.debug(
    `[GenerateProcedureResult] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const ResultSchema = z.object({ result: z.string() });

  try {
    const result = await retry(
      async (attempt, previousError) => {
        const res = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(ResultSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(
                userPrompt +
                  (previousError
                    ? `\nPrevious generation error: ${previousError.message}`
                    : "")
              ),
            ],
            context?.signal !== undefined
              ? { signal: context.signal }
              : undefined
          )
          .catch((error) => {
            handleLangchainError(error);
          });

        console.debug(
          `[GenerateProcedureResult] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.result;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateProcedureResult] Attempt ${attempt} failed: ${error.message}`;
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
    console.error("[GenerateProcedureResult] Error:", error);
    throw error;
  }
}

// ─── 3. generateDiagnosisBridge ───────────────────────────────────────────────

/**
 * Non-blinded bridge step: called when the blinded solver has exhausted its
 * iteration budget without reaching the diagnosis. Generates the remaining
 * confirmatory procedures (each with a result) that complete the diagnostic
 * pathway to the true diagnosis.
 */
export async function generateDiagnosisBridge(
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: Procedure[],
  procedureNameList?: ProcedureName[],
  userInstructions?: string,
  context?: RequestContext
): Promise<Procedure[]> {
  const effectiveProcedures =
    procedureNameList ?? getEffectiveProcedureList(context?.language);

  const systemPrompt = buildPrompt(
    `You are an expert attending physician completing a diagnostic workup for a medical training simulator.
The true diagnosis is known to you. The diagnostic workup so far has not yet confirmed the diagnosis.
Generate the remaining procedures — with clinically consistent results — that efficiently bridge from the current workup to a confirmed diagnosis.`,

    `Patient presentation:
${JSON.stringify(presentation, null, 2)}`,

    `True diagnosis: ${diagnosis.name}${diagnosis.icd ? ` (${diagnosis.icd})` : ""}`,

    previousProcedures.length > 0
      ? `Procedures already completed:
${previousProcedures.map((p, i) => `${i + 1}. ${p.name} → ${p.result}`).join("\n")}`
      : `No procedures have been completed yet.`,

    effectiveProcedures?.length
      ? `[RESTRICTED WORKUP]
You MUST ONLY select procedures from the following approved list. Do not invent procedures not explicitly listed below:
${effectiveProcedures.map((p) => `- ${p}`).join("\n")}`
      : undefined,

    `Requirements:
- Generate only the procedures needed to confirm the diagnosis, given what has already been done.
- Each procedure must include a result consistent with the true diagnosis.
- Use specific, professional medical terminology.
- Return ONLY the JSON object, no additional text.`,

    userInstructions ? `Additional instructions: ${userInstructions}` : undefined
  );

  const userPrompt = `Generate the remaining bridge procedures to confirm the diagnosis: ${diagnosis.name}${diagnosis.icd ? ` (${diagnosis.icd})` : ""}`;

  console.debug(
    `[GenerateDiagnosisBridge] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const BridgeSchema = z.object({
    procedures: z
      .array(buildProcedureSchema(effectiveProcedures))
      .describe("Bridge procedures that confirm the diagnosis"),
  });

  try {
    const procedures = await retry(
      async (attempt, previousError) => {
        const res = await getCreativeLLM(context?.llmConfig)
          .withStructuredOutput(BridgeSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(
                userPrompt +
                  (previousError
                    ? `\nPrevious generation error: ${previousError.message}`
                    : "")
              ),
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
    `You are a medical knowledge expert. Determine whether a proposed diagnosis is equivalent to the true diagnosis.
Consider synonyms, alternative names, abbreviations, and different levels of specificity.`,

    `True diagnosis: ${diagnosis.name}${diagnosis.icd ? ` (ICD: ${diagnosis.icd})` : ""}`,

    diagnosis.alternativeNames?.length
      ? `Alternative names: ${diagnosis.alternativeNames.join(", ")}`
      : undefined,

    `Return a JSON object with:
  "matches": true if the proposed name refers to the same or an equivalent condition, false otherwise.
  "reasoning": a brief explanation.
Return ONLY the JSON object, no additional text.`
  );

  const userPrompt = `Proposed diagnosis: ${proposedName}`;

  console.debug(
    `[MatchDiagnosis] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const MatchSchema = z.object({
    matches: z.boolean(),
    reasoning: z.string().optional(),
  });

  try {
    const matches = await retry(
      async (attempt, previousError) => {
        const res = await getDeterministicLLM(context?.llmConfig)
          .withStructuredOutput(MatchSchema)
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(
                userPrompt +
                  (previousError
                    ? `\nPrevious generation error: ${previousError.message}`
                    : "")
              ),
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
