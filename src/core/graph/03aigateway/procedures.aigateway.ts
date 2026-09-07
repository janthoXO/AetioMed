import { retry } from "../utils/retry.js";
import z from "zod";
import { handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  buildSystemPrompt,
  renderForPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "../utils/prompt.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import {
  ProcedureRelevanceSchema,
  type PlannedProcedure,
  type Procedure,
  type ProcedureRelevance,
} from "../models/Procedure.js";
import type { Patient } from "../models/Patient.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RequestContext } from "../utils/context.js";
import type { ForeignLanguage } from "../models/Language.js";
import { translateTermsKeyed } from "./translate.helper.js";
import type { GraphRuntime } from "../runtime.js";
import {
  buildCompositionSchema,
  describeProviders,
} from "../modality/composition.js";
import type { ModalityProvider, PlannedPart } from "../modality/ports.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

/**
 * The patient's presentation as seen by the blinded solver — no diagnosis.
 * A **text projection** (issue 11 §4), not the domain `Case` shape: bytes
 * must never reach a prompt, so every prompt builder's parameters are
 * strings. `presentationOf` (`03procedure/index.ts`) is the one place that
 * builds this from a domain `Case`, via `textOf`.
 */
export type Presentation = {
  patient?: Patient | undefined;
  chiefComplaint?: string | undefined;
  anamnesis?: { category: string; answer: string }[] | undefined;
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

/**
 * Result of a category-scoped procedure pick (PROCEDURE_PRESELECTION step 2):
 * either the actual pick, or a request to pull additional categories into
 * scope. The
 * expand action is only offered while the caller still allows it — the
 * grammar constraint restricts it to categories NOT already in scope, so the
 * model can never re-request one it has already seen.
 */
export type ScopedProcedurePickResult =
  | {
      action: "procedures";
      procedures: Procedure[];
      reasoning?: string | undefined;
    }
  | {
      action: "expand";
      categories: string[];
      reasoning?: string | undefined;
    };

// ─── Shared prompt sections ───────────────────────────────────────────────────

/**
 * The blinded solver's (and the bridge's) view of a procedure already
 * ordered, projected from `plannedProcedures` (issue 21 §7):
 * `result` is `parts.map(p => p.alt).join("\n\n")`, never the rendered
 * bytes — nothing has been rendered yet, so `alt` (the self-contained
 * clinical-finding statement `planProcedureResults` requires — see its doc
 * comment) is genuinely the only thing there is to reason over. This
 * replaces reading `textOf(p.result)` off a domain `ProcedureResult`, which
 * no longer exists at this point in the loop.
 */
export type PreviousProcedureFinding = {
  name: string;
  relevance: ProcedureRelevance;
  result: string;
};

function presentationSection(presentation: Presentation) {
  return section("Patient presentation", renderForPrompt(presentation));
}

/**
 * Renders only `name -> result` for each prior procedure. This is used by
 * both the blinded step and the non-blinded bridge step — it deliberately
 * omits `relevance`, which is a judgment relative to the TRUE diagnosis and
 * would leak it to the blinded solver if ever included here.
 */
function previousProceduresSection(
  previousProcedures: PreviousProcedureFinding[]
) {
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

function buildStepSchema(procedureFieldSchema: z.ZodTypeAny) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("procedure"),
      procedures: procedureFieldSchema,
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
 *   • action "procedure" — the next procedure(s) to order (name only — the
 *     solver never assigns relevance, since it doesn't know the diagnosis), or
 *   • action "diagnose"  — a diagnosis it commits to based on available evidence.
 */
export async function generateBlindedProcedureStep(
  runtime: GraphRuntime,
  presentation: Presentation,
  previousProcedures: PreviousProcedureFinding[],
  ruledOutDiagnoses: string[],
  userInstructions?: string,
  iterationsRemaining?: number,
  context?: RequestContext
): Promise<BlindedProcedureStepResult> {
  const candidates = runtime.catalogs.procedures
    .candidates()
    .exclude(previousProcedures.map((p) => p.name));

  if (candidates.isEmpty()) {
    // Every approved procedure has already been ordered — nothing left to
    // pick; the caller treats an empty pick as "bridge to the diagnosis".
    console.warn(
      "[GenerateBlindedProcedureStep] All approved procedures already ordered — returning empty pick."
    );
    return { action: "procedure", procedures: [] };
  }

  // Internal artifact (issue 09 §3): the blinded solver, English always.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "internal",
    section(
      "Role",
      `You are an attending physician working up a patient in a clinical training simulator.
You do NOT know the final diagnosis - reason purely from the patient's presentation and the results of procedures ordered so far.
You work under real-world time and cost constraints: every procedure costs time and money, so run a focused, high-yield workup — not an exhaustive one.
Your goal: reach a confident working diagnosis with as few procedures as possible.`
    ),

    section(
      "Rules",
      `Choose ONE action:
- "procedure": Order the next batch of clinically indicated procedures based on the available evidence. Order ONLY high-yield procedures that will meaningfully change your leading diagnosis — skip tests that merely add marginal confirmation or chase unlikely alternatives. You may schedule MULTIPLE procedures together in the same batch, but ONLY if they are mutually independent — none of them interferes with, contraindicates, or depends on the result of another in the batch. If a procedure's indication depends on the result of another procedure you'd also want to order now, leave it for a later iteration instead of batching it.
- "diagnose": Commit to a diagnosis as soon as one clearly best explains the presentation and the evidence so far (roughly 90% confidence). You do NOT need certainty, and you do NOT need to rule out every alternative — a real physician stops testing once the leading diagnosis is well supported and no dangerous alternative remains plausible. When in doubt between ordering another marginal procedure and diagnosing, prefer to diagnose.

When an approved procedure list is provided, every procedure name MUST be an exact name from that list.
Do NOT re-order any procedure that already appears in the workup so far.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object matching one of these shapes:
${renderSchemaForPrompt(buildStepSchema(candidates.promptSchema()))}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    candidates.render(),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    ruledOutDiagnoses.length > 0
      ? section(
          "Ruled-out diagnoses",
          `The following diagnoses have already been ruled out — do NOT propose any of these again:
${ruledOutDiagnoses.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
        )
      : undefined,

    workupBudgetSection(iterationsRemaining),

    `Based on the patient's presentation and the workup so far, what is your next action?`
  );

  console.debug(
    `[GenerateBlindedProcedureStep] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const StepSchema = buildStepSchema(candidates.grammar());

    const rawResult = await retry(
      async (attempt, previousError) => {
        // Balanced: this is clinical decision-making, not creative writing —
        // lower temperature keeps procedure choices focused and output short.
        const res = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            context?.llmConfig
          )
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
        runtime.log.error(msg);
      }
    );

    if (rawResult.action === "diagnose") {
      return rawResult;
    }

    // Reunite grouped/flat names with their category prefix (if any) —
    // the blinded step's public shape is always a plain `Procedure[]`.
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

// ─── generateBlindedCategoryStep (PROCEDURE_PRESELECTION: step 1 of 2) ───────

export type BlindedCategoryStepResult =
  | {
      action: "categories";
      categories?: string[] | undefined;
      reasoning?: string | undefined;
    }
  | {
      action: "diagnose";
      diagnosisName?: string | undefined;
      reasoning?: string | undefined;
    };

/**
 * Same grammar-vs-prompt split as {@link buildStepSchema}: the `categories`
 * restriction is applied to the grammar constraint but not to the schema
 * rendered into the system prompt.
 */
function buildCategoryStepSchema(categories?: string[]) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("categories"),
      categories: z
        .array(categories?.length ? z.literal(categories) : z.string())
        .describe(
          "ALL procedure categories that could plausibly be relevant — be over-inclusive, a second step narrows down to the exact procedures"
        ),
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
 * Step 1 of the small-model-friendly split of the blinded procedure pick
 * (enabled via `PROCEDURE_PRESELECTION`, dispatched from the
 * `CategoryScopedPick` strategy adapter): choose the plausibly-relevant
 * procedure categories — over-inclusive, since
 * {@link generateBlindedProcedureStepFromCategories} narrows down to actual
 * procedures next — or commit to a diagnosis. The diagnose handling mirrors
 * {@link generateBlindedProcedureStep} exactly, so the graph node can reuse
 * the same `matchDiagnosis` / ruled-out-diagnoses flow for either path.
 */
export async function generateBlindedCategoryStep(
  runtime: GraphRuntime,
  presentation: Presentation,
  previousProcedures: PreviousProcedureFinding[],
  ruledOutDiagnoses: string[],
  userInstructions?: string,
  iterationsRemaining?: number,
  context?: RequestContext
): Promise<BlindedCategoryStepResult> {
  // Categories are picked from the duplicate-filtered candidate set: fully
  // ordered categories vanish from the menu, and the size/sample hints
  // reflect only the procedures still available to order.
  const candidates = runtime.catalogs.procedures
    .candidates()
    .exclude(previousProcedures.map((p) => p.name));
  const categories = candidates.categories();

  // Internal artifact (issue 09 §3): the blinded solver's category pick,
  // English always.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "internal",
    section(
      "Role",
      `You are an attending physician working up a patient in a clinical training simulator.
You do NOT know the final diagnosis - reason purely from the patient's presentation and the results of procedures ordered so far.
You work under real-world time and cost constraints: aim for a confident working diagnosis with as few procedures as possible, not an exhaustive workup.
Your goal: narrow down the categories of diagnostic workup that could plausibly help — a second step will pick the exact procedures from within them.`
    ),

    section(
      "Rules",
      `Choose ONE action:
- "categories": List ALL procedure categories that could plausibly be relevant to the next diagnostic step. Be over-inclusive — it is fine (and expected) to list categories that turn out not to be needed, since a second step will pick the exact procedures from within them.
- "diagnose": Commit to a diagnosis as soon as one clearly best explains the presentation and the evidence so far (roughly 90% confidence). You do NOT need certainty, and you do NOT need to rule out every alternative — a real physician stops testing once the leading diagnosis is well supported and no dangerous alternative remains plausible. When in doubt between exploring more categories and diagnosing, prefer to diagnose.

Every category name MUST be an exact name from the provided list.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object matching one of these shapes:
${renderSchemaForPrompt(buildCategoryStepSchema())}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    section("Available procedure categories", candidates.categoryMenu()),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    ruledOutDiagnoses.length > 0
      ? section(
          "Ruled-out diagnoses",
          `The following diagnoses have already been ruled out — do NOT propose any of these again:
${ruledOutDiagnoses.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
        )
      : undefined,

    workupBudgetSection(iterationsRemaining),

    `Based on the patient's presentation and the workup so far, which categories are worth exploring next?`
  );

  console.debug(
    `[GenerateBlindedCategoryStep] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const CategoryStepSchema = buildCategoryStepSchema(categories);

    const result: BlindedCategoryStepResult = await retry(
      async (attempt, previousError) => {
        // Thinking off: the category shortlist is a constrained pick and the
        // split into two small steps exists precisely to keep each call fast.
        const res = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            { ...context?.llmConfig, enableThinking: false }
          )
          .withStructuredOutput(CategoryStepSchema)
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
          `[GenerateBlindedCategoryStep] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateBlindedCategoryStep] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return result;
  } catch (error) {
    console.error("[GenerateBlindedCategoryStep] Error:", error);
    throw error;
  }
}

// ─── generateBlindedProcedureStepFromCategories (preselection: step 2 of 2) ──

/**
 * Assemble the scoped-pick response schema from its optional branches — used
 * for both the grammar constraint and the name-agnostic prompt rendering so
 * the two can never diverge structurally. Same grammar-vs-prompt split as
 * {@link procedurePickGrammarSchema} / {@link procedurePickPromptSchema}.
 */
function scopedPickSchema(
  proceduresField: z.ZodTypeAny | undefined,
  expandCategoriesField: z.ZodTypeAny | undefined
): z.ZodTypeAny {
  const pick = proceduresField
    ? z.object({
        action: z.literal("procedures"),
        procedures: proceduresField,
        reasoning: z.string().optional().describe("brief clinical reasoning"),
      })
    : undefined;
  const expand = expandCategoriesField
    ? z.object({
        action: z.literal("expand"),
        categories: expandCategoriesField.describe(
          "exact names of the additional categories to pull into scope"
        ),
        reasoning: z
          .string()
          .optional()
          .describe("why the in-scope procedures don't suffice"),
      })
    : undefined;
  if (pick && expand) return z.discriminatedUnion("action", [pick, expand]);
  const single = pick ?? expand;
  if (!single) throw new Error("scopedPickSchema requires at least one branch");
  return single;
}

/**
 * Step 2 of the small-model-friendly split: pick the actual procedures from
 * within the categories {@link generateBlindedCategoryStep} selected, plus
 * the always-included uncategorized "General" bucket (uncategorized
 * procedures bypass the category filter entirely). Uses the exact same
 * grouped prompt/schema shape as {@link generateBlindedProcedureStep}'s
 * grouped mode — just scoped to fewer categories, so the candidate set a
 * small model has to reason over stays short.
 *
 * When `expandableCategories` is non-empty the model may instead answer with
 * an "expand" action naming additional categories to pull into scope. The
 * expand branch's grammar is restricted to exactly those categories, so a
 * category already in scope can never be re-requested; the caller loops on
 * expand under a hard cap and passes an empty `expandableCategories` once
 * the cap is reached, which removes the branch from the schema entirely and
 * forces a pick.
 */
export async function generateBlindedProcedureStepFromCategories(
  runtime: GraphRuntime,
  presentation: Presentation,
  previousProcedures: PreviousProcedureFinding[],
  selectedCategories: string[],
  expandableCategories: string[],
  userInstructions?: string,
  context?: RequestContext
): Promise<ScopedProcedurePickResult> {
  const ordered = previousProcedures.map((p) => p.name);
  const scoped = runtime.catalogs.procedures
    .scope(selectedCategories)
    .exclude(ordered);
  // Only offer expansion into categories that still have unordered candidates.
  const all = runtime.catalogs.procedures.candidates().exclude(ordered);
  const expandable = expandableCategories.filter((category) =>
    all.categories().includes(category)
  );

  const canPick = !scoped.isEmpty();
  const canExpand = expandable.length > 0;

  if (!canPick && !canExpand) {
    console.warn(
      "[GenerateBlindedProcedureStepFromCategories] No candidates in scope and nothing left to expand into — returning empty pick."
    );
    return { action: "procedures", procedures: [] };
  }

  const pickRules = `Order the next batch of clinically indicated procedures based on the available evidence (action "procedures"). You work under real-world time and cost constraints: order ONLY high-yield procedures that will meaningfully change the leading diagnosis — skip tests that merely add marginal confirmation or chase unlikely alternatives. You may schedule MULTIPLE procedures together in the same batch, but ONLY if they are mutually independent — none of them interferes with, contraindicates, or depends on the result of another in the batch. If a procedure's indication depends on the result of another procedure you'd also want to order now, leave it for a later iteration instead of batching it.

Every procedure name MUST be an exact name from the provided list, placed under its correct category key. Do NOT re-order any procedure that already appears in the workup so far.`;

  const expandRules = `If — and ONLY if — none of the in-scope procedures is clinically appropriate as the next step, respond with action "expand" and name the additional categories you need (exact names from the "Other available categories" section); they will be shown in full next. Otherwise always prefer action "procedures".`;

  // Internal artifact (issue 09 §3): the blinded solver's scoped pick,
  // English always.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "internal",
    section(
      "Role",
      `You are an attending physician working up a patient in a clinical training simulator.
You do NOT know the final diagnosis - reason purely from the patient's presentation and the results of procedures ordered so far.
A first step already narrowed the workup down to a shortlist of categories; your goal now is to pick the exact next procedure(s) from within them.`
    ),

    section(
      "Rules",
      [canPick ? pickRules : undefined, canExpand ? expandRules : undefined]
        .filter((rule): rule is string => !!rule)
        .join("\n\n")
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object matching ${canPick && canExpand ? "one of these shapes" : "this shape"}:
${renderSchemaForPrompt(
  scopedPickSchema(
    canPick ? scoped.promptSchema() : undefined,
    canExpand ? z.array(z.string()) : undefined
  )
)}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    canPick ? scoped.render() : undefined,

    canExpand
      ? section(
          "Other available categories (names only)",
          `These categories are NOT currently in scope — request them via action "expand" only if the in-scope procedures don't suffice:
${all.categoryMenu(expandable)}`
        )
      : undefined,

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    `Based on the patient's presentation and the workup so far, which procedures should be ordered next?`
  );

  console.debug(
    `[GenerateBlindedProcedureStepFromCategories] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const OutputSchema = scopedPickSchema(
    canPick ? scoped.grammar() : undefined,
    canExpand ? z.array(z.literal(expandable)) : undefined
  );

  try {
    const raw = await retry(
      async (attempt, previousError) => {
        // Thinking off: same rationale as the category step — the candidate
        // set is already scoped, so the pick doesn't need a reasoning phase.
        const res = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            { ...context?.llmConfig, enableThinking: false }
          )
          .withStructuredOutput(OutputSchema)
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
          `[GenerateBlindedProcedureStepFromCategories] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateBlindedProcedureStepFromCategories] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    if (raw.action === "expand") {
      return {
        action: "expand",
        categories: (raw.categories as string[] | undefined) ?? [],
        reasoning: raw.reasoning,
      };
    }

    return {
      action: "procedures",
      procedures: scoped.assemble(raw.procedures),
      reasoning: raw.reasoning,
    };
  } catch (error) {
    console.error("[GenerateBlindedProcedureStepFromCategories] Error:", error);
    throw error;
  }
}

// ─── 2. planProcedureResults ──────────────────────────────────────────────────

/**
 * Builds the per-procedure plan schema: `buildCompositionSchema`'s per-unit
 * plan entry (`{ key, requests }`), extended with `relevance` — a procedure
 * result needs both a rendering plan AND a relevance judgment from the same
 * (non-blinded) LLM call, and `buildCompositionSchema` alone has no field for
 * the latter. `unitKeys` is always passed here: a batch's procedure names are
 * already known — chosen by the blinded step, or picked non-blindedly by the
 * bridge (`pickBridgeProcedures`/`pickBridgeProceduresFromCategories` below)
 * — before this is ever called, so this is always the "known unit set" mode
 * `buildCompositionSchema`'s doc comment describes, never the freeform one.
 */
function buildProcedureResultPlanSchema(
  providers: ModalityProvider<unknown>[],
  procedureNames: string[]
) {
  const composition = buildCompositionSchema(
    providers,
    procedureNames
  ) as z.ZodObject<{
    plans: z.ZodArray<
      z.ZodObject<{ key: z.ZodTypeAny; requests: z.ZodTypeAny }>
    >;
  }>;
  const planWithRelevance = composition.shape.plans.element.extend({
    relevance: ProcedureRelevanceSchema.describe(
      "Relevance of the procedure to the TRUE diagnosis"
    ),
  });
  return z.object({
    plans: z.array(planWithRelevance).length(procedureNames.length),
  });
}

/**
 * Non-blinded result step: given the patient presentation, the TRUE
 * diagnosis, and a batch of concurrently-scheduled procedures, PLANS a
 * result AND a relevance judgment for each (issue 21 §7) — it no longer
 * generates result text directly. The blinded solver never knows the true
 * diagnosis, so it cannot meaningfully judge relevance (e.g. it would never
 * knowingly order a "contraindicated" procedure) — both `relevance` and the
 * plan are decided here instead. Rendering happens later, once for the
 * whole case, in `render_results` (`03procedure/index.ts`).
 *
 * **The `alt` rule is different here than everywhere else it appears in this
 * codebase, and it is the crux of issue 21 §7's design.** Everywhere else
 * `alt` is a short label, read only once bytes already exist. Here the
 * blinded solver reasons over `alt` and NOTHING else — the bytes do not
 * exist yet — so each `alt` must be a self-contained statement of the
 * clinical finding, not a bare label:
 *
 *   good: "Chest X-ray: consolidation of the left lower lobe with air bronchograms"
 *   bad:  "chest x-ray image"
 *
 * Getting this wrong does not fail any test; it quietly makes the solver
 * unable to solve. See `models/Procedure.ts`'s `PlannedProcedureSchema` doc
 * comment for the same rule at the projection site.
 */
export async function planProcedureResults(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: Diagnosis,
  procedureSteps: Procedure[],
  providers: ModalityProvider<unknown>[],
  outline?: string,
  userInstructions?: string,
  context?: RequestContext
): Promise<PlannedProcedure[]> {
  const procedureNames = procedureSteps.map((p) => p.name);
  const schema = buildProcedureResultPlanSchema(providers, procedureNames);

  // User-facing (issue 09 §3): a planned `alt`/instruction both become
  // user-visible content once rendered.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "user-facing",
    section(
      "Role",
      `You are a medical simulator PLANNING realistic results for a batch of diagnostic procedures ordered at the same time.
The true diagnosis is known to you. Plan a result AND a relevance judgment for EACH procedure, clinically consistent with both the true diagnosis and the patient's presentation. You do not render any bytes yourself — you plan how each result should be rendered.
These procedures were chosen by a separate, BLINDED solver who does not know the true diagnosis — it ordered them based on the presentation alone, so some may turn out to be unnecessary or even contraindicated in hindsight.`
    ),

    section(
      "Rules",
      `- Provide exactly one plan entry per procedure in the batch, keyed by its exact "name".
- Each plan's "alt" MUST be a self-contained statement of the clinical finding, not a bare label — a later step renders bytes from "alt" alone, without seeing anything else you produced. Write "Chest X-ray: consolidation of the left lower lobe with air bronchograms", not "chest x-ray image".
- Each finding must be clinically consistent with the true diagnosis. Use specific, realistic medical findings (e.g., exact lab values, imaging descriptions). Keep each finding concise (1–3 sentences).
- Prefer a single request against the "text" provider per procedure, unless another available provider would clearly add value.
- Judge "relevance" relative to the TRUE diagnosis, not the blinded solver's reasoning:
  - "obligatory": essential to establishing or confirming this diagnosis.
  - "optional": clinically reasonable and supportive, but not required for this diagnosis.
  - "contraindicated": not indicated, or potentially harmful/misleading, given this diagnosis — even if the blinded solver had a reasonable reason to order it without knowing the diagnosis.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section("Available providers", describeProviders(providers)),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(schema)}`
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

    `Plan clinically realistic results for these procedures.`
  );

  console.debug(
    `[PlanProcedureResults] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const plans = await retry(
      async (attempt, previousError) => {
        // Balanced: results must follow the blueprint's workup strategy and
        // stay clinically plausible — specific values, not invention.
        const res = (await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            context?.llmConfig
          )
          .withStructuredOutput(schema)
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
          })) as {
          plans: {
            key: string;
            requests: PlannedPart[];
            relevance: ProcedureRelevance;
          }[];
        };

        console.debug(
          `[PlanProcedureResults] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.plans;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[PlanProcedureResults] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    // Merge plans back onto the input steps, matching by "key" (falling back
    // to positional index — belt-and-braces, since `key` is grammar-pinned to
    // an exact `z.enum` of `procedureNames` with a matching array length, so
    // every step should always find its plan). Same merge strategy the old
    // direct result generator used before this became a planner.
    return procedureSteps.map((step, index) => {
      const match = plans.find((p) => p.key === step.name) ?? plans[index]!;
      return {
        name: step.name,
        relevance: match.relevance,
        parts: match.requests,
      };
    });
  } catch (error) {
    console.error("[PlanProcedureResults] Error:", error);
    throw error;
  }
}

// ─── 3. Bridge procedure picking ──────────────────────────────────────────────
//
// The bridge no longer generates results itself (issue 21 §7): it PICKS
// confirmatory procedure names — bare `Procedure[]`, exactly the shape
// `pendingProcedures` already has after a blinded "order" move — and then
// defers to `planProcedureResults` (the SAME planner `result_step` calls)
// for relevance and a rendering plan
// (`03procedure/strategy/directPick.ts`'s `DirectPick.bridge`,
// `categoryScopedPick.ts`'s `CategoryScopedPick.bridge`). Because picking is
// now name-only, `ProcedureCandidates.grammar()`/`.assemble()` — already
// used by the blinded step's own "procedure" action — cover the
// flat/grouped/freeform cases uniformly, so the bespoke
// `bareProcedureResultSchema`/`bridgePickGrammarSchema`/`assembleBridgeResults`
// trio this replaced is gone rather than duplicated.

function buildBridgePickSchema(procedureFieldSchema: z.ZodTypeAny) {
  return z.object({
    procedures: procedureFieldSchema,
    reasoning: z.string().optional().describe("brief clinical reasoning"),
  });
}

/**
 * Non-blinded bridge pick: called when the blinded solver has exhausted its
 * iteration budget without reaching the diagnosis. Picks the remaining
 * confirmatory procedure names that complete the diagnostic pathway to the
 * true diagnosis — `planProcedureResults` plans their results and
 * `render_results` renders them, alongside every other planned procedure,
 * once the case is solved.
 */
export async function pickBridgeProcedures(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: PreviousProcedureFinding[],
  userInstructions?: string,
  context?: RequestContext
): Promise<Procedure[]> {
  const candidates = runtime.catalogs.procedures
    .candidates()
    .exclude(previousProcedures.map((p) => p.name));

  if (candidates.isEmpty()) {
    console.warn(
      "[PickBridgeProcedures] All approved procedures already ordered — nothing left to bridge with."
    );
    return [];
  }

  // Internal (issue 09 §3): a name-only pick, no free text ever reaches the
  // student from this step — the planning/rendering steps that follow do.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "internal",
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
        // Balanced: confirmatory procedures for a known diagnosis — the most
        // clinically standard choices are exactly what we want.
        const res = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            context?.llmConfig
          )
          .withStructuredOutput(PickSchema)
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

// ─── generateBridgeCategoryStep (PROCEDURE_PRESELECTION: bridge step 1 of 2) ──

/**
 * Same grammar-vs-prompt split as {@link buildCategoryStepSchema}: the
 * `categories` restriction is applied to the grammar constraint but not to
 * the schema rendered into the system prompt.
 */
function buildBridgeCategoryStepSchema(categories?: string[]) {
  return z.object({
    categories: z
      .array(categories?.length ? z.literal(categories) : z.string())
      .describe(
        "ALL procedure categories that could plausibly contain the confirmatory procedures needed — be over-inclusive, a second step narrows down to the exact procedures"
      ),
    reasoning: z.string().optional().describe("brief clinical reasoning"),
  });
}

/**
 * Step 1 of the small-model-friendly split of the bridge (enabled via
 * `PROCEDURE_PRESELECTION`): unlike the blinded step's category pick, this
 * is non-blinded (the true diagnosis is already known) and has no "diagnose"
 * branch — its
 * only job is narrowing the workup down to a shortlist of categories that
 * plausibly contain the confirmatory procedures, over-inclusive by design.
 */
export async function generateBridgeCategoryStep(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: PreviousProcedureFinding[],
  userInstructions?: string,
  context?: RequestContext
): Promise<string[]> {
  // Same duplicate-filtered candidate set as the blinded category step: fully
  // ordered categories vanish, and size/sample hints reflect remaining
  // candidates.
  const candidates = runtime.catalogs.procedures
    .candidates()
    .exclude(previousProcedures.map((p) => p.name));
  const categories = candidates.categories();

  // Internal (issue 09 §3): a category shortlist, no free text ever reaches
  // the student from this step — the second step's results do.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "internal",
    section(
      "Role",
      `You are an expert attending physician completing a diagnostic workup for a medical training simulator.
The true diagnosis is known to you. Your goal: narrow down the categories of diagnostic workup that could plausibly contain the confirmatory procedures needed — a second step will pick the exact procedures from within them.`
    ),

    section(
      "Rules",
      `List ALL procedure categories that could plausibly contain the confirmatory procedures needed to complete the diagnostic workup. Be over-inclusive — it is fine (and expected) to list categories that turn out not to be needed, since a second step will pick the exact procedures from within them.

Every category name MUST be an exact name from the provided list.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(buildBridgeCategoryStepSchema())}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    section("True diagnosis", diagnosisLabel(diagnosis)),

    section("Available procedure categories", candidates.categoryMenu()),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    `Which categories are worth exploring to confirm the diagnosis?`
  );

  console.debug(
    `[GenerateBridgeCategoryStep] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const CategoryStepSchema = buildBridgeCategoryStepSchema(categories);

    const categoriesResult = await retry(
      async (attempt, previousError) => {
        const res = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            context?.llmConfig
          )
          .withStructuredOutput(CategoryStepSchema)
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
          `[GenerateBridgeCategoryStep] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.categories;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateBridgeCategoryStep] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return categoriesResult;
  } catch (error) {
    console.error("[GenerateBridgeCategoryStep] Error:", error);
    throw error;
  }
}

// ─── pickBridgeProceduresFromCategories (preselection: bridge step 2) ────────

/**
 * Step 2 of the small-model-friendly split of the bridge pick: choose the
 * confirmatory procedure NAMES from within the categories
 * {@link generateBridgeCategoryStep} selected, plus the always-included
 * uncategorized "General" bucket — mirrors
 * {@link generateBlindedProcedureStepFromCategories}'s "procedures" action,
 * minus the expand branch (the diagnosis is already known here, so
 * `CategoryScopedPick.bridge` widens deterministically to all categories on
 * an empty pick instead of looping on a model-driven expand).
 */
export async function pickBridgeProceduresFromCategories(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: PreviousProcedureFinding[],
  selectedCategories: string[],
  userInstructions?: string,
  context?: RequestContext
): Promise<Procedure[]> {
  const scoped = runtime.catalogs.procedures
    .scope(selectedCategories)
    .exclude(previousProcedures.map((p) => p.name));

  if (scoped.isEmpty()) {
    // Nothing left in scope — the caller widens to all categories and retries.
    console.warn(
      "[PickBridgeProceduresFromCategories] No unordered candidates in the selected categories — returning empty pick."
    );
    return [];
  }

  // Internal (issue 09 §3): a name-only pick, scoped to a category shortlist.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "internal",
    section(
      "Role",
      `You are an expert attending physician completing a diagnostic workup for a medical training simulator.
The true diagnosis is known to you. A first step already narrowed the workup down to a shortlist of categories; your goal now is to choose the remaining procedures — from within them — that efficiently bridge from the current workup to a confirmed diagnosis. A later step plans their results.`
    ),

    section(
      "Rules",
      `- Choose only the procedures needed to confirm the diagnosis, given what has already been done.
- Every procedure name MUST be an exact name from the provided list, placed under its correct category key.
- Do NOT re-order any procedure that already appears in the workup so far.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(buildBridgePickSchema(scoped.promptSchema()))}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    section("True diagnosis", diagnosisLabel(diagnosis)),

    scoped.render(),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    `Which procedures should be ordered to confirm the diagnosis?`
  );

  console.debug(
    `[PickBridgeProceduresFromCategories] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const PickSchema = buildBridgePickSchema(scoped.grammar());

  try {
    const rawProcedures = await retry(
      async (attempt, previousError) => {
        const res = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            context?.llmConfig
          )
          .withStructuredOutput(PickSchema)
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
          `[PickBridgeProceduresFromCategories] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.procedures;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[PickBridgeProceduresFromCategories] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return scoped.assemble(rawProcedures);
  } catch (error) {
    console.error("[PickBridgeProceduresFromCategories] Error:", error);
    throw error;
  }
}

// ─── procedure-result TEXT rendering (issue 21 §4/§7) ────────────────────────

/**
 * The procedure-result field's TEXT-rendering call: renders an entire batch
 * of planner-authored instructions — potentially spanning every procedure
 * `render_results` (`03procedure/index.ts`) flattened together — in ONE LLM
 * call. The batching is the whole point of `ModalityProvider.render`'s
 * batch-in/batch-out contract (`modality/ports.ts`): a loop of single calls
 * here would defeat the design. Unlike `planProcedureResults`'s `alt`
 * (the diagnostic payload the blinded solver reasons over), this renders
 * whatever instruction the plan supplied — by the time this runs the case is
 * already solved, so there is no blinded view left to protect.
 */
export async function renderProcedureResultTexts(
  runtime: GraphRuntime,
  instructions: string[],
  context?: RequestContext
): Promise<string[]> {
  const schema = z.object({
    texts: z
      .array(z.string().min(1))
      .length(instructions.length)
      .describe(
        "Rendered procedure-result text, one per instruction, in the same order"
      ),
  });

  // User-facing (issue 09 §3): procedure result text is read by the student.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "user-facing",
    section(
      "Role",
      `You are a medical simulator rendering procedure results for a clinical training simulator.
You will be given one or more instructions, each fully describing one procedure result to render. Render EXACTLY what each instruction says — you do not decide clinical facts, only wording.`
    ),

    section(
      "Rules",
      `- Use specific, professional medical terminology.
- Render each instruction into its own text; invent nothing beyond what the instruction states.
- Return exactly ${instructions.length} text(s), in the same order as the instructions.
- Return ONLY the JSON object, no additional text like prefix or suffix.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(schema)}`
    )
  );

  const userPrompt = buildPrompt(
    section(
      "Instructions to render",
      instructions
        .map((instruction, i) => `### ${i + 1}\n${instruction}`)
        .join("\n\n")
    )
  );

  console.debug(
    `[RenderProcedureResultTexts] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const result = await runtime.llm
        .for({ role: "generator", temperature: "balanced" }, context?.llmConfig)
        .withStructuredOutput(schema)
        .invoke(
          [
            new SystemMessage(systemPrompt),
            new HumanMessage(userPrompt + errorFeedback(previousError)),
          ],
          context?.signal !== undefined ? { signal: context.signal } : undefined
        )
        .catch((error) => {
          handleLangchainError(error);
        });

      console.debug(
        `[RenderProcedureResultTexts] [Attempt ${attempt}] Response:\n`,
        JSON.stringify(result, null, 2)
      );

      return result.texts;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[RenderProcedureResultTexts] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );
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
  runtime: GraphRuntime,
  proposedName: string,
  diagnosis: Diagnosis,
  context?: RequestContext
): Promise<boolean> {
  // Internal (issue 09 §3): matchDiagnosis is explicitly named in the
  // audience split — English always.
  const systemPrompt = buildSystemPrompt(
    runtime,
    "internal",
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
        const res = await runtime.llm
          .for(
            { role: "judge", temperature: "deterministic" },
            context?.llmConfig
          )
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
        runtime.log.error(msg);
      }
    );

    return matches;
  } catch (error) {
    console.error("[MatchDiagnosis] Error:", error);
    throw error;
  }
}

export async function generateProceduresFromEnglish(
  runtime: GraphRuntime,
  procedureNames: string[],
  language: ForeignLanguage,
  context?: RequestContext
): Promise<Record<string, string>> {
  return translateTermsKeyed(runtime, {
    logTag: "GenerateProceduresFromEnglish",
    taskDescription: `Translate the provided procedures from English to a target language.`,
    contextLines: [`Target language: ${language}`],
    terms: procedureNames,
    context,
  });
}
