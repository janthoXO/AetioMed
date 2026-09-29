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
import type {
  LevelItem,
  ProcedureCandidates,
} from "@/core/graph/catalog/ports.js";
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
export function previousProceduresSection(
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

export function ruledOutSection(ruledOutDiagnoses: string[]) {
  return ruledOutDiagnoses.length > 0
    ? section(
        "Ruled-out diagnoses",
        `The following diagnoses have already been ruled out — do NOT propose any of these again:
${ruledOutDiagnoses.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
      )
    : undefined;
}

const BLINDED_ROLE = `You are an attending physician working up a patient in a clinical training simulator.
You do NOT know the final diagnosis - reason purely from the patient's presentation and the results of procedures ordered so far.
You work under real-world time and cost constraints: every procedure costs time and money, so run a focused, high-yield workup — not an exhaustive one.
Your goal: reach a confident working diagnosis with as few procedures as possible.`;

const DIAGNOSE_RULE = `- "diagnose": Commit to a diagnosis as soon as one clearly best explains the presentation and the evidence so far (roughly 90% confidence). You do NOT need certainty, and you do NOT need to rule out every alternative — a real physician stops testing once the leading diagnosis is well supported and no dangerous alternative remains plausible. When in doubt between ordering another marginal procedure and diagnosing, prefer to diagnose.`;

const DiagnoseActionSchema = z.object({
  action: z.literal("diagnose"),
  diagnosisName: z.string().describe("the diagnosis you commit to"),
  reasoning: z.string().optional().describe("brief clinical reasoning"),
});

// ─── Procedure grouping (category-aware prompting) ───────────────────────────

/** Convergence-pressure nudge rendered when the solver's budget is known. */
function workupBudgetSection(iterationsRemaining: number | undefined) {
  return iterationsRemaining === undefined
    ? undefined
    : section(
        "Workup budget",
        `You have ${iterationsRemaining} diagnostic step(s) remaining. A thorough workup that uses every step is a FAILURE mode, not diligence — commit to a diagnosis as soon as one is well supported (roughly 90% confidence), and do not spend steps on marginal or merely confirmatory procedures.`
      );
}

// ─── 1. generateBlindedProcedureStep ─────────────────────────────────────────

function buildStepSchema(
  procedureFieldSchema: z.ZodTypeAny,
  allowDiagnose: boolean
) {
  const order = z.object({
    action: z.literal("procedure"),
    procedures: procedureFieldSchema,
    reasoning: z.string().optional().describe("brief clinical reasoning"),
  });
  return allowDiagnose
    ? z.discriminatedUnion("action", [order, DiagnoseActionSchema])
    : z.discriminatedUnion("action", [order]);
}

/**
 * Blinded step: the solver sees only the patient presentation, prior
 * procedure results, and previously ruled-out diagnoses. It does NOT receive
 * the true diagnosis. It returns either:
 *   • action "procedure" — the next procedure(s) to order (name only — the
 *     solver never assigns relevance, since it doesn't know the diagnosis), or
 *   • action "diagnose"  — a diagnosis it commits to based on available evidence,
 *     unless `allowDiagnose` is false (a level selection earlier in this step
 *     already offered it).
 * `candidates`: what is left to order, possibly narrowed level by level.
 */
export async function generateBlindedProcedureStep(
  runtime: GraphRuntime,
  candidates: ProcedureCandidates,
  presentation: Presentation,
  previousProcedures: PreviousProcedureFinding[],
  ruledOutDiagnoses: string[],
  userInstructions?: string,
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

When an approved procedure list is provided, every procedure name MUST be an exact name from that list.
Do NOT re-order any procedure that already appears in the workup so far.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object matching one of these shapes:
${renderSchemaForPrompt(buildStepSchema(candidates.promptSchema(), allowDiagnose))}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    candidates.render(),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    ruledOutSection(ruledOutDiagnoses),

    workupBudgetSection(iterationsRemaining),

    `Based on the patient's presentation and the workup so far, what is your next action?`
  );

  console.debug(
    `[GenerateBlindedProcedureStep] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const StepSchema = buildStepSchema(candidates.grammar(), allowDiagnose);

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

    // Reattach category prefix; public shape is plain `Procedure[]`.
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

// ─── decideBlindedCommit ───────────────────────────────────────────────────────

/**
 * The commit half of a blinded step, for a System One pick (`SystemOnePick`):
 * diagnose now, or continue and let the decider pick. System One cannot name
 * a diagnosis, so this stays an LLM call; the LLM picker fuses both halves
 * into {@link generateBlindedProcedureStep} instead.
 */
export async function decideBlindedCommit(
  runtime: GraphRuntime,
  presentation: Presentation,
  previousProcedures: PreviousProcedureFinding[],
  ruledOutDiagnoses: string[],
  userInstructions?: string,
  iterationsRemaining?: number,
  context?: RequestContext
): Promise<
  | { action: "continue"; reasoning?: string | undefined }
  | z.infer<typeof DiagnoseActionSchema>
> {
  const schema = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("continue"),
      reasoning: z.string().optional().describe("brief clinical reasoning"),
    }),
    DiagnoseActionSchema,
  ]);

  // Internal: blinded solver, English always.
  const systemPrompt = buildPrompt(
    section("Role", BLINDED_ROLE),
    section(
      "Rules",
      `Choose ONE action:
- "continue": More procedures are needed before a diagnosis is well supported. A later step chooses which.
${DIAGNOSE_RULE}`
    ),
    section(
      "Output format",
      `Return ONLY a valid JSON object matching one of these shapes:
${renderSchemaForPrompt(schema)}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),
    section("Additional instructions", userInstructions),
    previousProceduresSection(previousProcedures),
    ruledOutSection(ruledOutDiagnoses),
    workupBudgetSection(iterationsRemaining),
    `Based on the patient's presentation and the workup so far, do you diagnose now or continue the workup?`
  );

  console.debug(
    `[DecideBlindedCommit] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return retry(
    async (attempt, previousError) => {
      const res = await runtime.llm.structured(
        { role: "generator", temperature: "balanced" },
        {
          system: systemPrompt,
          user: userPrompt + errorFeedback(previousError),
        },
        schema,
        context
      );
      console.debug(
        `[DecideBlindedCommit] [Attempt ${attempt}] Response:\n`,
        JSON.stringify(res, null, 2)
      );
      return res;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[DecideBlindedCommit] Attempt ${attempt} failed: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );
}

// ─── selectProcedureLevel ─────────────────────────────────────────────────────

export type LevelSelection =
  | { action: "select"; items: LevelItem[]; reasoning?: string | undefined }
  | {
      action: "diagnose";
      diagnosisName: string;
      reasoning?: string | undefined;
    };

/**
 * What one level selection sees. `blinded` never carries the diagnosis (same
 * guard as `BlindedView`); `bridge` knows it and never diagnoses.
 */
export type LevelSelectionView =
  | {
      mode: "blinded";
      presentation: Presentation;
      previousProcedures: PreviousProcedureFinding[];
      ruledOutDiagnoses: string[];
      userInstructions?: string | undefined;
      iterationsRemaining: number;
      allowDiagnose: boolean;
    }
  | {
      mode: "bridge";
      presentation: Presentation;
      diagnosis: Diagnosis;
      previousProcedures: PreviousProcedureFinding[];
      userInstructions?: string | undefined;
    };

export function levelItemLabel(item: LevelItem): string {
  return item.kind === "category" ? item.path.join(" › ") : refLabel(item.ref);
}

function renderLevelItem(item: LevelItem): string {
  if (item.kind === "procedure") return `- ${refLabel(item.ref)}`;
  const more = item.size > item.sample.length ? ", …" : "";
  return `- ${levelItemLabel(item)} (category, ${item.size} procedures, e.g. ${item.sample.join(", ")}${more})`;
}

/**
 * One level of narrowing a catalogue too large to pick from at once: the
 * model chooses whole categories and/or single procedures from `items`; the
 * caller opens the chosen categories one level deeper or lets the model pick
 * from them. Blinded mode may diagnose instead (first level only).
 */
export async function selectProcedureLevel(
  runtime: GraphRuntime,
  view: LevelSelectionView,
  items: LevelItem[],
  context?: RequestContext
): Promise<LevelSelection> {
  const byLabel = new Map(items.map((item) => [levelItemLabel(item), item]));
  const allowDiagnose = view.mode === "blinded" && view.allowDiagnose;

  const select = z.object({
    action: z.literal("select"),
    items: z
      .array(z.literal([...byLabel.keys()]))
      .describe("exact labels of the categories and procedures to keep"),
    reasoning: z.string().optional().describe("brief clinical reasoning"),
  });
  const schema = allowDiagnose
    ? z.discriminatedUnion("action", [select, DiagnoseActionSchema])
    : z.discriminatedUnion("action", [select]);
  const promptSchema = z.object({
    action: z.literal("select"),
    items: z
      .array(z.string())
      .describe("exact labels of the categories and procedures to keep"),
    reasoning: z.string().optional().describe("brief clinical reasoning"),
  });

  const narrowing = `The approved procedure catalogue is too large to show at once, so it is narrowed level by level. Choose the categories that contain procedures you may want to order now, and any single procedures listed directly. You then see the full contents of the chosen categories and pick exact procedures from them — anything you do not choose here is unavailable for this step, so be inclusive, but leave out clearly irrelevant areas.`;

  const systemPrompt = buildPrompt(
    section(
      "Role",
      view.mode === "blinded"
        ? BLINDED_ROLE
        : `You are an expert attending physician completing a diagnostic workup for a medical training simulator.
The true diagnosis is known to you. The diagnostic workup so far has not yet confirmed the diagnosis. You are choosing where in the catalogue the confirmatory procedures are.`
    ),
    section(
      "Rules",
      allowDiagnose
        ? `Choose ONE action:
- "select": ${narrowing}
${DIAGNOSE_RULE}`
        : narrowing
    ),
    section(
      "Output format",
      `Return ONLY a valid JSON object matching ${allowDiagnose ? "one of these shapes" : "this shape"}:
${renderSchemaForPrompt(
  allowDiagnose
    ? z.discriminatedUnion("action", [promptSchema, DiagnoseActionSchema])
    : promptSchema
)}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(view.presentation),
    view.mode === "bridge"
      ? section("True diagnosis", diagnosisLabel(view.diagnosis))
      : undefined,
    section(
      "Catalogue level (choose by exact label)",
      items.map(renderLevelItem).join("\n")
    ),
    section("Additional instructions", view.userInstructions),
    previousProceduresSection(view.previousProcedures),
    view.mode === "blinded"
      ? ruledOutSection(view.ruledOutDiagnoses)
      : undefined,
    view.mode === "blinded"
      ? workupBudgetSection(view.iterationsRemaining)
      : undefined,
    view.mode === "blinded"
      ? `Based on the patient's presentation and the workup so far, which parts of the catalogue are relevant for your next batch?`
      : `Which parts of the catalogue contain the procedures needed to confirm the diagnosis?`
  );

  console.debug(
    `[SelectProcedureLevel] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const raw = await retry(
    async (attempt, previousError) => {
      const res = (await runtime.llm.structured(
        { role: "generator", temperature: "balanced" },
        {
          system: systemPrompt,
          user: userPrompt + errorFeedback(previousError),
        },
        schema,
        context
      )) as
        | { action: "select"; items: string[]; reasoning?: string }
        | { action: "diagnose"; diagnosisName: string; reasoning?: string };
      console.debug(
        `[SelectProcedureLevel] [Attempt ${attempt}] Response:\n`,
        JSON.stringify(res, null, 2)
      );
      return res;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[SelectProcedureLevel] Attempt ${attempt} failed: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );

  if (raw.action === "diagnose") return raw;
  return {
    action: "select",
    items: [...new Set(raw.items)].flatMap((label) => {
      const item = byLabel.get(label);
      return item ? [item] : [];
    }),
    reasoning: raw.reasoning,
  };
}

// ─── 3. Bridge procedure picking ──────────────────────────────────────────────
//
// Bridge PICKS confirmatory procedure names (bare `Procedure[]`, same shape
// as `pendingProcedures` after a blinded "order"), then defers to
// `planProcedureResults` (same planner as `result_step`) for relevance and
// rendering plan (`DrillDownPick.bridge`).
// `ProcedureCandidates.grammar()`/`.assemble()` cover flat/grouped/freeform.

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
  userInstructions?: string,
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
- When an approved procedure list is provided, every procedure name MUST be an exact name from that list.
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

    section("Additional instructions", userInstructions),

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
