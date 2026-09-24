import { handleLangchainError } from "../utils/llm.js";
import {
  buildPrompt,
  buildSystemPrompt,
  section,
  summarizeValidationError,
  type PromptAudience,
} from "../utils/prompt.js";
import type { Diagnosis } from "../models/Diagnosis.js";
import type { BasisFragment } from "../medicalBasis/ports.js";
import { renderMedicalBasisSection } from "../medicalBasis/render.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { retry } from "../utils/retry.js";
import type { RequestContext } from "../utils/context.js";
import {
  FIXED_CLOSE,
  FIXED_OPEN,
  OutlineFormatError,
  checkSkeleton,
  outlineSkeleton,
  parseTaggedOutline,
  renderTaggedOutline,
  type OutlineSegments,
} from "../outline/segments.js";
import type { Difficulty } from "../models/Difficulty.js";
import type { GraphRuntime } from "../runtime.js";

const DIFFICULTY_STRATEGY: Record<Difficulty, string> = {
  easy: `- Feature a clear, classic subset of this diagnosis's hallmark symptoms only. Do not include distractor symptoms from other conditions.
- Procedure/workup results should be definitive and textbook — clearly consistent with the diagnosis, with no ambiguity.
- The clinical picture should point toward the diagnosis fairly directly, while still never naming it.`,
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
 * results need patient/presentation/anamnesis, and plan reviewer edits one stable shape.
 */
export async function generateCaseOutline(
  runtime: GraphRuntime,
  diagnosis: Diagnosis,
  basisFragments: BasisFragment[],
  difficulty: Difficulty,
  opts: {
    userInstructions?: string | undefined;
    feedback?: string[] | undefined;
    previousOutline?: OutlineSegments | undefined;
    /**
     * `"internal"` (English) except plan mode with sandwich off: request
     * language. With sandwich on, `languageOverride` keeps English either way.
     */
    audience?: PromptAudience | undefined;
  } = {},
  context?: RequestContext
): Promise<OutlineSegments> {
  const { userInstructions, feedback, previousOutline } = opts;
  const audience = opts.audience ?? "internal";
  const anamnesisCategories = runtime.catalogs.anamnesis.list();
  const skeleton = outlineSkeleton({ anamnesisCategories });

  const structure = anamnesisCategories
    ? skeleton.map((heading) => `${FIXED_OPEN}${heading}${FIXED_CLOSE}`)
    : [
        ...skeleton.map((heading) =>
          heading === "## Procedures"
            ? `${FIXED_OPEN}### <intake category name>${FIXED_CLOSE}   (one per anamnesis category you choose, before Procedures)\n${FIXED_OPEN}${heading}${FIXED_CLOSE}`
            : `${FIXED_OPEN}${heading}${FIXED_CLOSE}`
        ),
      ];

  // Internal (English) by default; caller may bind request language.
  const systemPrompt = buildSystemPrompt(
    runtime,
    audience,
    section(
      "Role",
      `You are an expert medical educator tasked with creating a concrete outline for a clinical practice case based on a specific diagnosis.
This blueprint will act as the SINGLE SOURCE OF TRUTH for downstream AI agents generating the final JSON fields, INCLUDING the eventual procedure/workup results. It is the COMPLETE FACTUAL RECORD of the case: downstream agents only rewrite its facts in the right voice and format — they never add facts of their own.`
    ),

    section(
      "Instructions",
      `1. Write the outline under the fixed headings listed in "Structure", with hard, concrete data in each section:
   - General: the clinical picture — select a clinically coherent subset of the reference symptoms (see "Medical basis", when present) to feature, with concrete onset, duration, severity, timeline, and any distractors the difficulty strategy calls for.
   - Patient: exact age, sex, height (in cm), weight (in kg), and any relevant demographic details.
   - Chief complaint: the specific presenting problem in one or two factual sentences.
   - Anamnesis: under each intake category heading, the concrete facts to state (history items, medications with names and doses, lifestyle details, family history).
   - Procedures: the workup / procedure results strategy — how procedure and lab results should be shaped per the difficulty strategy, so a downstream agent generating those results can follow it.
2. Downstream generators must be able to write their field using ONLY facts from this outline. Any fact not specified here does not exist. Do not leave placeholders or vague descriptions.
3. Make sure that all sections are clinically coherent with each other.
4. The diagnosis must never be explicitly named anywhere in the outline's content — the student must deduce it.
5. Return ONLY the outline. Do not include introductory text, acknowledgments, or conversational filler.`
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
        const result = await runtime.llm
          .for(
            { role: "generator", temperature: "creative" },
            { ...context?.llmConfig, outputFormat: "text" }
          )
          .invoke(
            [
              new SystemMessage(systemPrompt),
              new HumanMessage(
                userPrompt +
                  (previousError
                    ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
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
          `[GenerateCaseOutline] [Attempt ${attempt}] LLM raw Response:\n`,
          result.text
        );

        // Off-skeleton outline rejected; retry feeds mismatch back.
        const segments = parseTaggedOutline(result.text);
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
