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
 * Patient presentation as seen by blinded solver, no diagnosis. Text
 * projection, not domain `Case`: bytes never reach a prompt. Built only by
 * `presentationOf` (`03procedure/index.ts`) via `textOf`.
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
 * Category-scoped pick result (PROCEDURE_PRESELECTION step 2): the pick, or
 * request to add categories. Expand offered only while caller allows; grammar
 * restricts it to categories NOT already in scope.
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
 * Blinded solver's (and bridge's) view of an ordered procedure, projected from
 * `plannedProcedures`: `result` is `parts.map(p => p.alt).join("\n\n")`.
 * Nothing rendered yet, so `alt` (see `planProcedureResults`) is all there is.
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
    // All approved procedures ordered; empty pick means "bridge".
    console.warn(
      "[GenerateBlindedProcedureStep] All approved procedures already ordered — returning empty pick."
    );
    return { action: "procedure", procedures: [] };
  }

  // Internal: blinded solver, English always.
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
        // Balanced: clinical decision-making; lower temperature keeps picks focused.
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

/** Grammar-vs-prompt split as {@link buildStepSchema}: `categories` restriction in grammar only, not prompt schema. */
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
 * Step 1 of blinded pick under `PROCEDURE_PRESELECTION` (`CategoryScopedPick`):
 * choose plausibly-relevant categories (over-inclusive; next step narrows) or
 * commit to a diagnosis. Diagnose handling mirrors
 * {@link generateBlindedProcedureStep} so same `matchDiagnosis` flow applies.
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
  // Picked from duplicate-filtered candidates: fully ordered categories vanish; hints reflect remaining only.
  const candidates = runtime.catalogs.procedures
    .candidates()
    .exclude(previousProcedures.map((p) => p.name));
  const categories = candidates.categories();

  // Internal: blinded category pick, English always.
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
        // Thinking off: constrained pick, keep call fast.
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
 * Assembles scoped-pick response schema from optional branches; used for both
 * grammar and prompt rendering so they can't diverge. See
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
 * Step 2: pick procedures from categories {@link generateBlindedCategoryStep}
 * selected plus uncategorized "General" bucket (bypasses category filter).
 * Same grouped prompt/schema as {@link generateBlindedProcedureStep}, fewer categories.
 *
 * Non-empty `expandableCategories` lets model answer "expand" naming extra
 * categories; grammar restricted to exactly those. Caller loops under a cap,
 * then passes empty `expandableCategories`, removing the branch and forcing a pick.
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

  // Internal: blinded scoped pick, English always.
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
        // Thinking off: candidates already scoped.
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
 * Per-procedure plan schema: `buildCompositionSchema` unit entry
 * (`{ key, requests }`) plus `relevance`, both from one non-blinded call.
 * `unitKeys` always passed: procedure names known beforehand, never freeform.
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
 * Non-blinded result step: given presentation, TRUE diagnosis and a batch of
 * procedures, PLANS result and `relevance` for each. Blinded solver can't judge
 * relevance. Rendering later, once, in `render_results` (`03procedure/index.ts`).
 *
 * `alt` rule differs here: blinded solver reasons over `alt` ONLY (no bytes
 * yet), so each `alt` must be a self-contained finding, not a label:
 *
 *   good: "Chest X-ray: consolidation of the left lower lobe with air bronchograms"
 *   bad:  "chest x-ray image"
 *
 * No test catches a bad one; solver just can't solve. See
 * `PlannedProcedureSchema` in `models/Procedure.ts`.
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

  // User-facing: planned `alt`/instruction become user-visible content.
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
        // Balanced: follow outline's workup strategy, plausible specific values.
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

    // Merge plans onto steps by "key", falling back to index (key is
    // grammar-pinned to `procedureNames`, so a plan should always be found).
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
// Bridge PICKS confirmatory procedure names (bare `Procedure[]`, same shape
// as `pendingProcedures` after a blinded "order"), then defers to
// `planProcedureResults` (same planner as `result_step`) for relevance and
// rendering plan (`DirectPick.bridge`, `CategoryScopedPick.bridge`).
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

  // Internal: name-only pick, no free text reaches student from this step.
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
        // Balanced: want the most standard confirmatory procedures.
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

/** Grammar-vs-prompt split as {@link buildCategoryStepSchema}: `categories` restriction in grammar only, not prompt schema. */
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
 * Step 1 of bridge under `PROCEDURE_PRESELECTION`. Non-blinded, no "diagnose"
 * branch: shortlist categories plausibly containing confirmatory procedures,
 * over-inclusive.
 */
export async function generateBridgeCategoryStep(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: PreviousProcedureFinding[],
  userInstructions?: string,
  context?: RequestContext
): Promise<string[]> {
  // Duplicate-filtered candidates, as blinded category step.
  const candidates = runtime.catalogs.procedures
    .candidates()
    .exclude(previousProcedures.map((p) => p.name));
  const categories = candidates.categories();

  // Internal: category shortlist, no free text reaches student.
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
 * Step 2 of bridge: pick confirmatory procedure NAMES from categories
 * {@link generateBridgeCategoryStep} selected plus "General". Mirrors
 * {@link generateBlindedProcedureStepFromCategories}, no expand branch:
 * `CategoryScopedPick.bridge` widens to all categories on empty pick.
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
    // Nothing in scope; caller widens to all categories and retries.
    console.warn(
      "[PickBridgeProceduresFromCategories] No unordered candidates in the selected categories — returning empty pick."
    );
    return [];
  }

  // Internal: name-only pick scoped to category shortlist.
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

// ─── procedure-result TEXT rendering ─────────────────────────────────────────

/**
 * Text rendering for procedure results: whole batch of planner instructions
 * (all procedures from `render_results`) in ONE LLM call, per
 * `ModalityProvider.render` batch contract. Renders whatever instruction the
 * plan supplied; case already solved, no blinded view to protect.
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

  // User-facing: student reads result text.
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
  // Internal: English always.
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
