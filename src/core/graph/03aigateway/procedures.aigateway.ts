import { retry } from "../utils/retry.js";
import z from "zod";
import { handleLangchainError } from "../utils/llm.js";
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
  ProcedureRelevanceSchema,
  type Procedure,
  type ProcedureName,
  type ProcedureRelevance,
  type ProcedureResult,
} from "../models/Procedure.js";
import {
  UNCATEGORIZED_CATEGORY,
  type ProcedurePickMode,
} from "../catalog/ports.js";
import type { Patient } from "../models/Patient.js";
import type { Anamnesis } from "../models/Anamnesis.js";
import type { ChiefComplaint } from "../models/ChiefComplaint.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RequestContext } from "../utils/context.js";
import type { ForeignLanguage } from "../models/Language.js";
import { translateTermsKeyed } from "./translate.helper.js";
import type { GraphRuntime } from "../runtime.js";

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

/**
 * Result of a category-scoped procedure pick (LLM_SMALL step 2): either the
 * actual pick, or a request to pull additional categories into scope. The
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

function presentationSection(presentation: Presentation) {
  return section("Patient presentation", renderForPrompt(presentation));
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
  previousProcedures: ProcedureResult[],
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

  const systemPrompt = buildPrompt(
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

// ─── generateBlindedCategoryStep (LLM_SMALL: step 1 of 2) ────────────────────

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
 * (enabled via `LLM_SMALL`, dispatched from the `blinded_step` node): choose
 * the plausibly-relevant procedure categories — over-inclusive, since
 * {@link generateBlindedProcedureStepFromCategories} narrows down to actual
 * procedures next — or commit to a diagnosis. The diagnose handling mirrors
 * {@link generateBlindedProcedureStep} exactly, so the graph node can reuse
 * the same `matchDiagnosis` / ruled-out-diagnoses flow for either path.
 */
export async function generateBlindedCategoryStep(
  runtime: GraphRuntime,
  presentation: Presentation,
  previousProcedures: ProcedureResult[],
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

  const systemPrompt = buildPrompt(
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

// ─── generateBlindedProcedureStepFromCategories (LLM_SMALL: step 2 of 2) ─────

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
  previousProcedures: ProcedureResult[],
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

  const systemPrompt = buildPrompt(
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
  runtime: GraphRuntime,
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
        // Balanced: results must follow the blueprint's workup strategy and
        // stay clinically plausible — specific values, not invention.
        const res = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            context?.llmConfig
          )
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
        runtime.log.error(msg);
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

type ResultLeaf = {
  name: string;
  relevance: ProcedureRelevance;
  result: string;
};

const GenericResultLeafSchema = z.object({
  name: z.string().describe("exact procedure name"),
  relevance: ProcedureRelevanceSchema,
  result: z.string().describe("clinically realistic result, concise"),
});

/**
 * The bare-name-scoped counterpart to {@link buildProcedureResultSchema} —
 * used inside a grouped-by-category bridge pick, where "name" only needs to
 * be unique within its category group (the category key supplies the rest).
 */
function bareProcedureResultSchema(bareNames?: ProcedureName[]) {
  return z.object({
    name: (bareNames?.length ? z.literal(bareNames) : z.string()).describe(
      "exact bare procedure name (without category prefix)"
    ),
    relevance: ProcedureRelevanceSchema,
    result: z.string().describe("clinically realistic result, concise"),
  });
}

/**
 * The grammar-constrained schema for a bridge pick's "procedures" field, per
 * mode — this is what's passed to `withStructuredOutput`. Mirrors
 * {@link procedurePickGrammarSchema}, but each leaf is a full
 * `{name, relevance, result}` result instead of a bare name.
 */
function bridgePickGrammarSchema(mode: ProcedurePickMode): z.ZodTypeAny {
  switch (mode.kind) {
    case "freeform":
      return z
        .array(buildProcedureResultSchema())
        .describe("bridge procedures that confirm the diagnosis");
    case "flat":
      return z
        .array(bareProcedureResultSchema(mode.names))
        .describe("bridge procedures that confirm the diagnosis");
    case "grouped": {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [category, names] of mode.grouped) {
        shape[category] = z
          .array(bareProcedureResultSchema(names))
          .optional()
          .describe(
            `bridge procedures (without category prefix) from "${category}" that confirm the diagnosis`
          );
      }
      return z
        .object(shape)
        .describe(
          "bridge procedures that confirm the diagnosis, grouped by category key"
        );
    }
  }
}

/**
 * Generic, name-agnostic counterpart to {@link bridgePickGrammarSchema} used
 * ONLY for the system prompt's "Output format" example — mirrors
 * {@link procedurePickPromptSchema}'s stability rationale.
 */
function bridgePickPromptSchema(mode: ProcedurePickMode): z.ZodTypeAny {
  if (mode.kind === "grouped") {
    return z
      .record(z.string(), z.array(GenericResultLeafSchema))
      .describe(
        "bridge procedures that confirm the diagnosis, keyed by category"
      );
  }
  return z
    .array(GenericResultLeafSchema)
    .describe("bridge procedures that confirm the diagnosis");
}

/**
 * Assemble a raw bridge "procedures" LLM response back into `ProcedureResult[]`,
 * per pick mode — mirrors {@link assembleProcedurePick}, but preserves each
 * leaf's `relevance`/`result` alongside the reunited full name.
 */
function assembleBridgeResults(
  mode: ProcedurePickMode,
  raw: unknown,
  effectiveList: ProcedureName[] | undefined
): ProcedureResult[] {
  const canonical = effectiveList ? new Set(effectiveList) : undefined;
  const keep = (full: string) => !canonical || canonical.has(full);

  if (mode.kind !== "grouped") {
    return ((raw as ResultLeaf[] | undefined) ?? [])
      .filter((leaf) => keep(leaf.name))
      .map((leaf) => ({
        name: leaf.name,
        relevance: leaf.relevance,
        result: leaf.result,
      }));
  }

  const grouped = (raw as Record<string, ResultLeaf[] | undefined>) ?? {};
  const result: ProcedureResult[] = [];
  for (const [category, leaves] of Object.entries(grouped)) {
    if (!leaves) continue;
    for (const leaf of leaves) {
      const full =
        category === UNCATEGORIZED_CATEGORY
          ? leaf.name
          : `${category}: ${leaf.name}`;
      if (keep(full)) {
        result.push({
          name: full,
          relevance: leaf.relevance,
          result: leaf.result,
        });
      }
    }
  }
  return result;
}

/**
 * Non-blinded bridge step: called when the blinded solver has exhausted its
 * iteration budget without reaching the diagnosis. Generates the remaining
 * confirmatory procedures (each with a result) that complete the diagnostic
 * pathway to the true diagnosis. Uses the same category-grouped candidate
 * presentation as the blinded step.
 */
export async function generateDiagnosisBridge(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: ProcedureResult[],
  userInstructions?: string,
  context?: RequestContext
): Promise<ProcedureResult[]> {
  const candidates = runtime.catalogs.procedures
    .candidates()
    .exclude(previousProcedures.map((p) => p.name));

  if (candidates.isEmpty()) {
    console.warn(
      "[GenerateDiagnosisBridge] All approved procedures already ordered — nothing left to bridge with."
    );
    return [];
  }

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
- Do NOT re-order any procedure that already appears in the workup so far.
- These are bridge procedures YOU are choosing specifically to confirm the diagnosis, so their "relevance" should almost always be "obligatory" unless one is merely supportive ("optional").`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(z.object({ procedures: bridgePickPromptSchema(candidates.mode) }))}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    section("True diagnosis", diagnosisLabel(diagnosis)),

    candidates.render(),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    `Generate the remaining bridge procedures to confirm the diagnosis.`
  );

  console.debug(
    `[GenerateDiagnosisBridge] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const BridgeSchema = z.object({
    procedures: bridgePickGrammarSchema(candidates.mode),
  });

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
        runtime.log.error(msg);
      }
    );

    return assembleBridgeResults(
      candidates.mode,
      rawProcedures,
      runtime.catalogs.procedures.list()
    );
  } catch (error) {
    console.error("[GenerateDiagnosisBridge] Error:", error);
    throw error;
  }
}

// ─── generateBridgeCategoryStep (LLM_SMALL: bridge step 1 of 2) ──────────────

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
 * `LLM_SMALL`): unlike the blinded step's category pick, this is non-blinded
 * (the true diagnosis is already known) and has no "diagnose" branch — its
 * only job is narrowing the workup down to a shortlist of categories that
 * plausibly contain the confirmatory procedures, over-inclusive by design.
 */
export async function generateBridgeCategoryStep(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: ProcedureResult[],
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

  const systemPrompt = buildPrompt(
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

// ─── generateBridgeProcedureStepFromCategories (LLM_SMALL: bridge step 2) ────

/**
 * Step 2 of the small-model-friendly split of the bridge: generate the
 * confirmatory procedures (with results) from within the categories
 * {@link generateBridgeCategoryStep} selected, plus the always-included
 * uncategorized "General" bucket. Same grouped prompt/schema/assembly as
 * {@link generateDiagnosisBridge}'s grouped mode — just scoped to fewer
 * categories.
 */
export async function generateBridgeProcedureStepFromCategories(
  runtime: GraphRuntime,
  presentation: Presentation,
  diagnosis: Diagnosis,
  previousProcedures: ProcedureResult[],
  selectedCategories: string[],
  userInstructions?: string,
  context?: RequestContext
): Promise<ProcedureResult[]> {
  const scoped = runtime.catalogs.procedures
    .scope(selectedCategories)
    .exclude(previousProcedures.map((p) => p.name));

  if (scoped.isEmpty()) {
    // Nothing left in scope — the caller widens to all categories and retries.
    console.warn(
      "[GenerateBridgeProcedureStepFromCategories] No unordered candidates in the selected categories — returning empty result."
    );
    return [];
  }

  const systemPrompt = buildPrompt(
    section(
      "Role",
      `You are an expert attending physician completing a diagnostic workup for a medical training simulator.
The true diagnosis is known to you. A first step already narrowed the workup down to a shortlist of categories; your goal now is to generate the remaining procedures — with clinically consistent results — that efficiently bridge from the current workup to a confirmed diagnosis, using only those categories.`
    ),

    section(
      "Rules",
      `- Generate only the procedures needed to confirm the diagnosis, given what has already been done.
- Each procedure must include a result consistent with the true diagnosis.
- Use specific, professional medical terminology.
- Every procedure name MUST be an exact name from the provided list, placed under its correct category key.
- Do NOT re-order any procedure that already appears in the workup so far.
- These are bridge procedures YOU are choosing specifically to confirm the diagnosis, so their "relevance" should almost always be "obligatory" unless one is merely supportive ("optional").`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(z.object({ procedures: bridgePickPromptSchema(scoped.mode) }))}`
    )
  );

  const userPrompt = buildPrompt(
    presentationSection(presentation),

    section("True diagnosis", diagnosisLabel(diagnosis)),

    scoped.render(),

    section("Additional instructions", userInstructions),

    previousProceduresSection(previousProcedures),

    `Generate the remaining bridge procedures to confirm the diagnosis.`
  );

  console.debug(
    `[GenerateBridgeProcedureStepFromCategories] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  const BridgeSchema = z.object({
    procedures: bridgePickGrammarSchema(scoped.mode),
  });

  try {
    const rawProcedures = await retry(
      async (attempt, previousError) => {
        const res = await runtime.llm
          .for(
            { role: "generator", temperature: "balanced" },
            context?.llmConfig
          )
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
          `[GenerateBridgeProcedureStepFromCategories] [Attempt ${attempt}] Response:\n`,
          JSON.stringify(res, null, 2)
        );

        return res.procedures;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateBridgeProcedureStepFromCategories] Attempt ${attempt} failed: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return assembleBridgeResults(
      scoped.mode,
      rawProcedures,
      runtime.catalogs.procedures.list()
    );
  } catch (error) {
    console.error("[GenerateBridgeProcedureStepFromCategories] Error:", error);
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
  runtime: GraphRuntime,
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
