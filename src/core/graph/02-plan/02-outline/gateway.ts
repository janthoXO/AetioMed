import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "@/core/graph/shared/prompt/prompt.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import type { BasisFragment } from "@/core/graph/02-plan/01-basis/ports.js";
import { renderMedicalBasisSection } from "@/core/graph/02-plan/01-basis/render.js";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import {
  FIXED_CLOSE,
  FIXED_OPEN,
  OutlineFormatError,
  checkSkeleton,
  outlineSkeleton,
  parseTaggedOutline,
  tagBareHeadings,
  renderTaggedOutline,
  type OutlineSegments,
} from "@/core/graph/shared/outline/segments.js";
import type { Difficulty } from "@/core/graph/shared/domain/Difficulty.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import {
  OutlineEvaluationSchema,
  type OutlineEvaluation,
} from "./outlineEvaluation.js";
import { instruction, rubric, type Recipe } from "./recipe.js";

const DIFFICULTY_STRATEGY: Record<Difficulty, string> = {
  easy: `- Feature a clear, classic subset of this diagnosis's hallmark symptoms only. Do not include distractor symptoms from other conditions.
- Procedure/workup results should be definitive and textbook — clearly consistent with the diagnosis, with no ambiguity.
- The clinical picture should point toward the diagnosis fairly directly, while still never naming it outside the diagnostic label.`,
  medium: `- Feature a clinically coherent subset of this diagnosis's hallmark symptoms, and additionally introduce 1–2 distractor symptoms drawn from a plausible differential diagnosis.
- Introduce minor or borderline changes in procedure/workup results (e.g. a value just outside normal range, a partially non-specific finding) so the picture is not immediately conclusive.
- The overall presentation should require some deductive reasoning; it should not be solvable from the chief complaint alone.`,
  hard: `- Present an atypical picture: omit one or more classic hallmark symptoms of this diagnosis, and include several distractor/differential symptoms from other plausible conditions.
- Make procedure/workup results ambiguous or requiring interpretation — avoid clean textbook values; results should be consistent with the diagnosis only on careful analysis.
- The case should require synthesizing multiple pieces of evidence and actively ruling out plausible alternatives before reaching the diagnosis.`,
};

/**
 * Generates outline as tag-delimited markdown, parsed to positional segments.
 * Headings are server-owned skeleton (`outlineSkeleton`) reproduced in `<fixed>`
 * tags; mismatch rejected and retried with error fed back (validation, not grammar).
 * All sections always outlined regardless of `generationFlags`: procedure
 * results need patient/presentation/anamnesis, the blinded solver reads the
 * section of a field not generated (#205), and plan reviewer edits one stable shape.
 */
export async function generateCaseOutline(
  runtime: GraphRuntime,
  diagnosis: Diagnosis,
  basisFragments: BasisFragment[],
  difficulty: Difficulty,
  opts: {
    /** Diagnostic label the server rolled (#216); none when unset. */
    recipe?: Recipe | undefined;
    userInstructions?: string | undefined;
    feedback?: string[] | undefined;
    previousOutline?: OutlineSegments | undefined;
    /**
     * Unset (English) except plan mode with sandwich off: request
     * language. With sandwich on, `languageOverride` keeps English either way.
     */
    language?: Language | undefined;
  } = {},
  context?: RequestContext
): Promise<OutlineSegments> {
  const { userInstructions, feedback, previousOutline } = opts;
  const anamnesisCategories = runtime.catalogs.anamnesis.list();
  // Freeform: one placeholder where the LLM-named category headings go.
  const placeholder = "<intake category name>";
  const structure = outlineSkeleton({
    anamnesisCategories: anamnesisCategories ?? [placeholder],
  }).map(
    (heading) =>
      `${FIXED_OPEN}${heading}${FIXED_CLOSE}` +
      (!anamnesisCategories && heading === `### ${placeholder}`
        ? "   (one per anamnesis category you choose)"
        : "")
  );

  // Internal (English) by default; caller may bind request language.
  const systemPrompt = buildSystemPrompt(
    opts.language,
    section(
      "Role",
      `You are an expert medical educator tasked with creating a concrete outline for a clinical practice case based on a specific diagnosis.
This blueprint will act as the SINGLE SOURCE OF TRUTH for downstream AI agents generating the final JSON fields, INCLUDING the eventual procedure/workup results. It is the COMPLETE FACTUAL RECORD of the case: downstream agents only rewrite its facts in the right voice and format — they never add facts of their own.`
    ),

    section(
      "Instructions",
      `1. Write the outline under the fixed headings listed in "Structure", with hard, concrete data in each section:
   - General: the clinical picture and its teaching design — select a clinically coherent subset of the reference symptoms (see "Medical basis", when present) to feature, with concrete onset, duration, severity and timeline; which symptoms are hallmark signs; which are distractors and which differential diagnosis each points to; how the difficulty strategy is applied. ALL pedagogical information belongs here and nowhere else. General is read only while the outline is planned and reviewed — no later author sees it — so any fact a later author needs must also be stated in the section that needs it (e.g. how results are hedged, or which finding refutes a misleading suspicion, goes into Procedures).
   - Patient: exact age, sex, height (in cm), weight (in kg), and any relevant demographic details.
   - Chief complaint: how the patient arrives and the presenting problem, in a few factual sentences: a referral if there is one (who referred, when, and the reason — symptoms only, unless the "Diagnostic label" section puts a suspicion there), then the presenting problem.
   - Anamnesis: under each intake category heading, the concrete facts to state (history items, medications with names and doses, lifestyle details, family history).
   - Procedures: the workup / procedure results strategy — how procedure and lab results should be shaped per the difficulty strategy (which findings are clear, borderline or ambiguous, and how definite imaging impressions are), so a downstream agent generating those results can follow it without seeing General.
2. Downstream generators must be able to write their field using ONLY facts from this outline. Any fact not specified here does not exist. Do not leave placeholders or vague descriptions.
3. The Patient, Chief complaint and Anamnesis sections state FACTS ONLY, as the patient's record would: no pedagogical annotations, no hints, no labels such as "hallmark", "classic sign", "distractor" or "red herring", and no reasoning about what a finding suggests. Each of these sections must be self-contained: repeat in it every fact its field needs (onset, duration, severity, timeline), even when General already describes it — a reader of only that section must get every fact.
4. Make sure that all sections are clinically coherent with each other.
5. Follow the "Diagnostic label" section exactly: it decides whether the presentation carries a suspected diagnosis, where, and how it relates to the true one. The student must still deduce the diagnosis.
6. Additional instructions, when given, come from the case author. Write every fact or requirement they contain into the section it belongs to (e.g. a requested lab finding into Procedures, a requested medication into Anamnesis). Downstream authors never see the instructions — only this outline.
7. Return ONLY the outline. Do not include introductory text, acknowledgments, or conversational filler.`
    ),

    section(
      "Structure",
      `Reproduce these fixed headings EXACTLY, in this order, each wrapped in ${FIXED_OPEN}…${FIXED_CLOSE} on its own line — never translate, rename, reorder or omit them. Write each section's content on the lines below its heading, OUTSIDE the tags. Never put anything else inside ${FIXED_OPEN} tags, and do not add other markdown headings.
${structure.join("\n")}`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    renderMedicalBasisSection(basisFragments),

    section(
      `Difficulty strategy (${difficulty})`,
      `This controls how unclear the diagnosis must remain to a student working through the case, both in the presentation AND in any workup/procedure results:
${DIFFICULTY_STRATEGY[difficulty]}`
    ),

    section(
      "Diagnostic label (decided by the server)",
      instruction(opts.recipe ?? [], diagnosis)
    ),

    anamnesisCategories
      ? section(
          "Anamnesis intake form categories",
          `The Anamnesis section must specify concrete facts for each of these intake form categories, under their fixed headings:
${anamnesisCategories.join(", ")}`
        )
      : undefined,

    section("Additional instructions", userInstructions),

    previousOutline
      ? section(
          "Previous outline (rejected)",
          renderTaggedOutline(previousOutline)
        )
      : undefined,

    feedback && feedback.length > 0
      ? section(
          "Feedback on the previous outline",
          `The previous outline was rejected for the following reasons. Revise it — keep what was good, and change only what is needed to address the feedback:
${feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
        )
      : undefined
  );

  console.debug(
    `[GenerateCaseOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    return await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await runtime.llm.text(
          { role: "generator", temperature: "creative" },
          {
            system: systemPrompt,
            user:
              userPrompt +
              (previousError
                ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                : ""),
          },
          context
        );

        console.debug(
          `[GenerateCaseOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          result
        );

        // Off-skeleton outline rejected; retry feeds mismatch back.
        const segments = parseTaggedOutline(
          tagBareHeadings(
            result,
            outlineSkeleton({ anamnesisCategories: anamnesisCategories ?? [] })
          )
        );
        const check = checkSkeleton(segments, { anamnesisCategories });
        if (!check.ok) {
          throw new OutlineFormatError(
            `The outline's fixed headings are wrong: ${check.message}`
          );
        }
        return segments;
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[GenerateCaseOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );
  } catch (error) {
    console.error(`[GenerateCaseOutline] Error:`, error);
    throw error;
  }
}

const DIFFICULTY_EXPECTATION: Record<Difficulty, string> = {
  easy: `At "easy" difficulty, the blueprint is EXPECTED to point fairly directly toward the diagnosis via a classic subset of hallmark symptoms. Only flag it as too obvious if the diagnosis name itself, or an unambiguous synonym/abbreviation of it, is leaked outside the diagnostic label.`,
  medium: `At "medium" difficulty, the blueprint should require some deductive reasoning: a subset of hallmark symptoms plus at least one distractor symptom or a borderline procedure-result change. Flag it as too obvious if the presentation is a textbook, unambiguous match for the diagnosis with no distractors or ambiguity at all, or if the diagnosis name is leaked outside the diagnostic label.`,
  hard: `At "hard" difficulty, the blueprint must present an atypical picture: at least one omitted hallmark symptom, multiple distractor/differential symptoms, and ambiguous procedure results. Flag it as too obvious if the presentation is a clean or typical match for the diagnosis, if there are no meaningful distractors, or if the diagnosis name is leaked outside the diagnostic label.`,
};

/**
 * Judges outline in one call on two dimensions:
 * 1. Obviousness: reveals diagnosis more directly than difficulty permits?
 * 2. Clinical consistency: diagnosis secrecy, coherence between fields, realism.
 * Runs before any field content is written.
 */
export async function evaluateOutline(
  runtime: GraphRuntime,
  diagnosis: Diagnosis,
  outline: string,
  difficulty: Difficulty,
  /** The label the generator was told to place (#216). */
  recipe: Recipe,
  userInstructions?: string,
  context?: RequestContext,
  /** Language outline was written in: English except plan mode, sandwich off (request language). */
  language?: Language | undefined
): Promise<OutlineEvaluation> {
  // Internal by default.
  const systemPrompt = buildSystemPrompt(
    language,
    section(
      "Role",
      `You are an expert medical educator reviewing a clinical case blueprint for a training simulator BEFORE the full case is written out. The blueprint is the single source of truth for all downstream field generation, so it must be sound. Judge it on TWO dimensions and accept it only if BOTH pass.`
    ),

    section(
      "Dimension 1: Obviousness",
      `Judge whether the blueprint makes the diagnosis too easy to guess for the requested difficulty level. Evaluate it holistically: the symptom selection, any distractors present, and the planned workup/procedure-result strategy described in it. A diagnostic label the server decided (see "Diagnostic label") is a hypothesis to the student, not an answer, even when correct: judge obviousness on the rest of the picture.`
    ),

    section(
      "Dimension 2: Clinical consistency",
      `1. Diagnostic label and secrecy (Pedagogical): the blueprint must realise the "Diagnostic label" exactly as described there. Naming means the diagnosis itself, a synonym or its abbreviation; physiological states, symptoms, findings, lab values and differential diagnoses do NOT name it. The same disease in a relative (family history) or as a known risk factor is NOT a leak: it is a clinical clue — weigh it under Obviousness only. The Procedures section is the results strategy, read only by an author who knows the diagnosis: it may name the target diagnosis, e.g. as the hedged impression of the test diagnostic for it — never a leak. The General section is the author's teaching design: it may describe hallmark signs, distractors, the difficulty strategy, the label and the intended diagnosis — never reject because of content in General. The Patient, Chief complaint and Anamnesis sections must state facts only: flag a pedagogical label there (hallmark, classic, typical, distractor, red herring, or a remark on what a finding suggests). Also flag a field section that relies on General for a fact it needs instead of stating that fact itself.
2. Clinical Coherence: Do the planned fields logically align? (e.g., Does the workup strategy make sense for the chief complaint? Does the planned anamnesis contradict the patient's age/gender?)
3. Realism: Are there impossible biometric values (e.g., a 2-year-old weighing 70kg), contradictory timelines, or medical hallucinations?
4. Author instructions: when Additional instructions are given, every fact or requirement in them must be stated in the section it belongs to. Flag one that is missing or contradicted.

IMPORTANT: Distractor symptoms, omitted hallmark symptoms, and ambiguous or borderline findings planned per the difficulty strategy are INTENTIONAL pedagogical design — do NOT flag them as inconsistencies.`
    ),

    section(
      "Requirements",
      `- Only flag genuine problems a downstream author must fix, not stylistic choices or things you would merely have done differently.
- Every reason must name its section and quote the exact offending text. If you cannot quote it, it is not a problem.
- When in doubt, accept.
- If the blueprint is rejected, give ONE actionable suggestion describing exactly how to revise it.`
    ),

    section(
      "Output format",
      `Return ONLY a valid JSON object:
${renderSchemaForPrompt(OutlineEvaluationSchema)}`
    )
  );

  const userPrompt = buildPrompt(
    section("Target diagnosis", `${diagnosis.name} ${diagnosis.icd ?? ""}`),

    section(
      `Requested difficulty (${difficulty})`,
      DIFFICULTY_EXPECTATION[difficulty]
    ),

    section(
      "Diagnostic label (decided by the server)",
      rubric(recipe, diagnosis)
    ),

    section("Blueprint to evaluate", outline),

    section("Additional instructions", userInstructions)
  );

  console.debug(
    `[EvaluateOutline] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  try {
    const evaluation: OutlineEvaluation = await retry(
      async (attempt: number, previousError?: Error) => {
        const result = await runtime.llm.structured(
          { role: "judge", temperature: "deterministic" },
          {
            system: systemPrompt,
            user:
              userPrompt +
              (previousError
                ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
                : ""),
          },
          OutlineEvaluationSchema,
          context
        );

        console.debug(
          `[EvaluateOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          JSON.stringify(result, null, 2)
        );

        return { ...result, reasons: result.reasons ?? [] };
      },
      2,
      0,
      (error, attempt) => {
        const msg = `[EvaluateOutline] Attempt ${attempt} failed with error: ${error.message}`;
        console.error(msg);
        runtime.log.error(msg);
      }
    );

    return evaluation;
  } catch (error) {
    console.error("[EvaluateOutline] Error:", error);
    throw error;
  }
}
