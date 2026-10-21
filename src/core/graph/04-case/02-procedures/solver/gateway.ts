import { retry } from "@/core/graph/shared/prompt/retry.js";
import z from "zod";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
} from "@/core/graph/shared/prompt/prompt.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import {
  refLabel,
  type ProcedureRef,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { ProcedureCandidates } from "@/core/graph/catalog/ports.js";
import {
  presentationSection,
  diagnosisLabel,
  errorFeedback,
  type Presentation,
  type BlindedProcedureStepResult,
  type PreviousProcedureFinding,
} from "../prompt.js";

/**
 * Renders `name -> result` per prior procedure, for blinded and bridge steps.
 * Omits `relevance`: relative to TRUE diagnosis, would leak it to blinded solver.
 */
function previousProceduresSection(
  previousProcedures: PreviousProcedureFinding[]
) {
  return section(
    "Procedures ordered so far (with results)",
    previousProcedures.length > 0
      ? previousProcedures
          .map((p, i) => `${i + 1}. ${refLabel(p)} -> ${p.result}`)
          .join("\n")
      : "No procedures have been ordered yet."
  );
}

function ruledOutSection(ruledOutDiagnoses: string[]) {
  return ruledOutDiagnoses.length > 0
    ? section(
        "Ruled-out diagnoses",
        `The following diagnoses were not accepted as the final diagnosis. Each may still be present as a finding, or be too unspecific. Do NOT propose any of these names again: name a more specific diagnosis or order further procedures.
${ruledOutDiagnoses.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
      )
    : undefined;
}

const BLINDED_ROLE = `You are an attending physician working up a patient in a clinical training simulator.
You do NOT know the final diagnosis - reason purely from the patient's presentation and the results of procedures ordered so far.
You work under real-world time and cost constraints: every procedure costs time and money, so run a focused, high-yield workup — not an exhaustive one.
Your goal: reach a confident working diagnosis with as few procedures as possible.
A diagnosis named in the presentation (a referral's suspicion, the patient's own belief) is a hypothesis to test, never evidence: it may be right, too broad, or wrong.`;

const DIAGNOSE_RULE = `- "diagnose": Commit to a diagnosis only when all of these hold:
  1. at least one ordered procedure result supports it — name that procedure in "supportingResult";
  2. no major finding in the presentation or the results is left unexplained;
  3. the dangerous (can't-miss) alternatives for the presenting complaint have been tested.
  You do NOT need certainty, and you do NOT need to rule out every unlikely alternative. A diagnosis named in the presentation counts only once a result supports it.`;

/**
 * `supportingResult` is an exact label of an ordered procedure, so a commit
 * names the result it rests on (#213). Diagnose is only offered once something
 * was ordered; the `z.string()` fallback just keeps the schema buildable.
 */
function diagnoseActionSchema(previousProcedures: PreviousProcedureFinding[]) {
  const labels = previousProcedures.map(refLabel);
  return z.object({
    action: z.literal("diagnose"),
    diagnosisName: z.string().describe("the diagnosis you commit to"),
    supportingResult: (labels.length > 0
      ? z.literal(labels)
      : z.string()
    ).describe("exact name of the ordered procedure whose result supports it"),
    reasoning: z.string().optional().describe("brief clinical reasoning"),
  });
}

// ─── Procedure grouping (category-aware prompting) ───────────────────────────

/** Convergence-pressure nudge rendered when the solver's budget is known. */
function workupBudgetSection(iterationsRemaining: number | undefined) {
  return iterationsRemaining === undefined
    ? undefined
    : section(
        "Workup budget",
        `You have ${iterationsRemaining} diagnostic step(s) remaining. A thorough workup that uses every step is a FAILURE mode, not diligence — commit as soon as the rules for diagnosing are met, and do not spend steps on marginal procedures.`
      );
}

// ─── 1. generateBlindedProcedureStep ─────────────────────────────────────────

function buildStepSchema(
  procedureFieldSchema: z.ZodTypeAny,
  allowDiagnose: boolean,
  previousProcedures: PreviousProcedureFinding[]
) {
  const order = z.object({
    action: z.literal("procedure"),
    procedures: procedureFieldSchema,
    reasoning: z.string().optional().describe("brief clinical reasoning"),
  });
  return allowDiagnose
    ? z.discriminatedUnion("action", [
        order,
        diagnoseActionSchema(previousProcedures),
      ])
    : z.discriminatedUnion("action", [order]);
}

/**
 * Blinded step: the solver sees only the patient presentation, prior
 * procedure results, and previously ruled-out diagnoses. It does NOT receive
 * the true diagnosis. It returns either:
 *   • action "procedure" — the next procedure(s) to order (name only — the
 *     solver never assigns relevance, since it doesn't know the diagnosis), or
 *   • action "diagnose"  — a diagnosis it commits to based on available evidence,
 *     unless `allowDiagnose` is false (nothing ordered yet).
 * `candidates`: what is left to order.
 */
export async function generateBlindedProcedureStep(
  runtime: GraphRuntime,
  candidates: ProcedureCandidates,
  presentation: Presentation,
  previousProcedures: PreviousProcedureFinding[],
  ruledOutDiagnoses: string[],
  iterationsRemaining?: number,
  context?: RequestContext,
  allowDiagnose = true
): Promise<BlindedProcedureStepResult> {
  if (candidates.isEmpty()) {
    // All approved procedures ordered; empty pick means "bridge".
    console.warn(
      "[GenerateBlindedProcedureStep] All approved procedures already ordered — returning empty pick."
    );
    return { action: "procedure", procedures: [] };
  }

  // Internal: blinded solver, English always.
  const systemPrompt = buildPrompt(
    section("Role", BLINDED_ROLE),

    section(
      "Rules",
      `Choose ONE action:
- "procedure": Order the next batch of clinically indicated procedures based on the available evidence. Order ONLY high-yield procedures that will meaningfully change your leading diagnosis — skip tests that merely add marginal confirmation or chase unlikely alternatives. You may schedule MULTIPLE procedures together in the same batch, but ONLY if they are mutually independent — none of them interferes with, contraindicates, or depends on the result of another in the batch. If a procedure's indication depends on the result of another procedure you'd also want to order now, leave it for a later iteration instead of batching it.
${allowDiagnose ? DIAGNOSE_RULE : ""}

When an approved procedure catalogue is provided, every procedure MUST be an exact label from it.
Do NOT re-order any procedure that already appears in the workup so far.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object matching one of these shapes:
${renderSchemaForPrompt(
  buildStepSchema(candidates.promptSchema(), allowDiagnose, previousProcedures)
)}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    candidates.render(),

    previousProceduresSection(previousProcedures),

    ruledOutSection(ruledOutDiagnoses),

    workupBudgetSection(iterationsRemaining),

    `Based on the patient's presentation and the workup so far, what is your next action?`
  );

  console.debug(
    `[GenerateBlindedProcedureStep] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const StepSchema = buildStepSchema(
      candidates.grammar(),
      allowDiagnose,
      previousProcedures
    );

    const rawResult = await retry(
      async (attempt, previousError) => {
        // Balanced: clinical decision-making; lower temperature keeps picks focused.
        const res = await runtime.llm.structured(
          { role: "generator", temperature: "balanced" },
          {
            system: systemPrompt,
            user: userPrompt + errorFeedback(previousError),
          },
          StepSchema,
          context
        );

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
        runtime.log.error(msg);
      }
    );

    if (rawResult.action === "diagnose") {
      return rawResult;
    }

    // Labels back to refs; public shape is plain `ProcedureRef[]`.
    return {
      action: "procedure",
      procedures: candidates.assemble(rawResult.procedures),
      reasoning: rawResult.reasoning,
    };
  } catch (error) {
    console.error("[GenerateBlindedProcedureStep] Error:", error);
    throw error;
  }
}

// ─── 2. Bridge procedure picking ──────────────────────────────────────────────
//
// Bridge PICKS confirmatory procedure names (bare `Procedure[]`, same shape
// as `pendingProcedures` after a blinded "order"), then defers to
// `planProcedureResults` (same planner as `result_step`) for relevance and
// rendering plan (`CatalogPick.bridge`).
// `ProcedureCandidates.grammar()`/`.assemble()` cover catalogue and freeform.

function buildBridgePickSchema(procedureFieldSchema: z.ZodTypeAny) {
  return z.object({
    procedures: procedureFieldSchema,
    reasoning: z.string().optional().describe("brief clinical reasoning"),
  });
}

/**
 * Non-blinded bridge pick, for when blinded solver exhausts its budget
 * without diagnosing. Picks remaining confirmatory procedure names leading to
 * the true diagnosis; `planProcedureResults` plans, `render_results` renders.
 */
export async function pickBridgeProcedures(
  runtime: GraphRuntime,
  candidates: ProcedureCandidates,
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: PreviousProcedureFinding[],
  context?: RequestContext
): Promise<ProcedureRef[]> {
  if (candidates.isEmpty()) {
    console.warn(
      "[PickBridgeProcedures] All approved procedures already ordered — nothing left to bridge with."
    );
    return [];
  }

  // Internal: name-only pick, no free text reaches student from this step.
  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert attending physician completing a diagnostic workup for a medical training simulator.
The true diagnosis is known to you. The diagnostic workup so far has not yet confirmed the diagnosis.
Choose the remaining procedures that efficiently bridge from the current workup to a confirmed diagnosis — a later step plans their results.`
    ),

    section(
      "Rules",
      `- Choose only the procedures needed to confirm the diagnosis, given what has already been done.
- When an approved procedure catalogue is provided, every procedure MUST be an exact label from it.
- Do NOT re-order any procedure that already appears in the workup so far.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(buildBridgePickSchema(candidates.promptSchema()))}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    section("True diagnosis", diagnosisLabel(diagnosis)),

    candidates.render(),

    previousProceduresSection(previousProcedures),

    `Which procedures should be ordered to confirm the diagnosis?`
  );

  console.debug(
    `[PickBridgeProcedures] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const PickSchema = buildBridgePickSchema(candidates.grammar());

  try {
    const rawProcedures = await retry(
      async (attempt, previousError) => {
        // Balanced: want the most standard confirmatory procedures.
        const res = await runtime.llm.structured(
          { role: "generator", temperature: "balanced" },
          {
            system: systemPrompt,
            user: userPrompt + errorFeedback(previousError),
          },
          PickSchema,
          context
        );

        console.debug(
          `[PickBridgeProcedures] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.procedures;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[PickBridgeProcedures] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return candidates.assemble(rawProcedures);
  } catch (error) {
    console.error("[PickBridgeProcedures] Error:", error);
    throw error;
  }
}
