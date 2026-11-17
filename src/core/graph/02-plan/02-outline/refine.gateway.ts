import z from "zod";
import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "@/core/graph/shared/prompt/prompt.js";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import type { Difficulty } from "@/core/graph/shared/domain/Difficulty.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type {
  GraphRuntime,
  LlmRole,
  LlmTemperature,
} from "@/core/graph/runtime.js";
import {
  joinOutline,
  sectionHeadings,
  type OutlineSegments,
} from "@/core/graph/shared/outline/segments.js";
import { rubric, type Recipe } from "./recipe.js";

/** How far a refine reaches (#272): case facts, one unit's plan, or wording only. */
export const RefineLevelSchema = z.enum(["outline", "plan", "render"]);
export type RefineLevel = z.infer<typeof RefineLevelSchema>;

export type Refinement = {
  level: RefineLevel;
  why: string;
  /** Sections whose facts must change, by heading segment index. */
  affected: { index: number; why: string }[];
  /** New bodies of the changed sections only, by heading segment index. */
  sections: Map<number, string>;
};

const LEVELS: Record<RefineLevel, string> = {
  outline: `"outline": the request changes case facts in the outline (e.g. "make the patient a child", "the finding should look like in a child"). Rewrite every section that must change so the whole outline stays consistent, including sections other than the target.`,
  plan: `"plan": the request changes only what the target states or how its facts are split into parts, and the outline still holds as written (e.g. "use the SCP codes of an anterior STEMI" when the outline already says anterior STEMI). A change that contradicts the Procedures strategy or the diagnosis is "outline", never "plan".`,
  render: `"render": the request changes presentation only, never a fact (e.g. "shorter", "more formal").`,
};

/**
 * Refiner (#272): one structured call that picks the lowest level a request
 * reaches and, at outline level, rewrites only the sections that change.
 * Sections are named by heading line and mapped back to segment indices here:
 * an index is arbitrary to a model, a heading is not. Also the judge loop's
 * revision step (`levels: ["outline"]`, judge feedback as the request).
 */
export async function refineOutline(
  runtime: GraphRuntime,
  input: {
    plan: OutlineSegments;
    diagnosis: Diagnosis;
    difficulty: Difficulty;
    recipe: Recipe;
    /** What the request is about, e.g. "the whole outline", "procedure 'Chest X-ray', part 1". */
    target: string;
    /** Current parts' content of the target, when it is a unit or part. */
    alts?: string[] | undefined;
    request: string;
    levels: RefineLevel[];
    /** Language the plan's bodies are written in; new bodies too. */
    language: Language | undefined;
    call: { role: LlmRole; temperature: LlmTemperature };
  },
  context?: RequestContext
): Promise<Refinement> {
  const headings = sectionHeadings(input.plan);
  const heading = z.enum(
    headings.map((h) => h.heading) as [string, ...string[]]
  );
  const level = z.enum(input.levels as [RefineLevel, ...RefineLevel[]]);
  const schema = z.object({
    level: level.describe("Lowest level the request reaches"),
    why: z.string().describe("One sentence: why this level"),
    affected: z
      .array(z.object({ heading, why: z.string() }))
      .describe(
        'Level "outline" only, written FIRST: every section whose facts must change for the outline to stay consistent, with what changes in it. Empty otherwise.'
      ),
    sections: z
      .array(z.object({ heading, text: z.string() }))
      .describe(
        'Level "outline" only: the complete new body of every affected section, without its heading. Sections not listed stay exactly as they are. Empty otherwise.'
      ),
  });

  const system = buildSystemPrompt(
    input.language,
    section(
      "Role",
      `You are an expert medical educator revising a clinical case outline for a training simulator. The outline is the single source of truth for the case; downstream authors write each field from its section only.`
    ),
    section("Levels", input.levels.map((l) => `- ${LEVELS[l]}`).join("\n")),
    section(
      "Rules",
      `- Change only what the request needs. A section you do not list stays byte-identical.
- List affected sections first, then rewrite exactly those: a change in one section (e.g. the patient's age) often forces changes in others (anamnesis, procedure results). Missing one leaves the case inconsistent.
- General holds the teaching design (hallmarks, distractors, the diagnostic label placed); update it when the design changes. Patient, Chief complaint and Anamnesis state facts only, no pedagogical labels; Procedures is the results strategy.
- Keep the diagnostic label below realised exactly, and never name the diagnosis in Patient, Chief complaint or Anamnesis.
- Name sections by their heading exactly as given.
- Return ONLY the JSON object.`
    ),
    section(
      "Output format",
      `Return ONLY a valid JSON object:\n${renderSchemaForPrompt(schema)}`
    )
  );

  const user = buildPrompt(
    section(
      "Target diagnosis",
      `${input.diagnosis.name} ${input.diagnosis.icd ?? ""}`
    ),
    section(`Difficulty`, input.difficulty),
    section(
      "Diagnostic label (decided by the server)",
      rubric(input.recipe, input.diagnosis)
    ),
    section("Outline", joinOutline(input.plan)),
    section("Target", input.target),
    section(
      "Target's current parts",
      input.alts?.map((alt, i) => `${i}. ${alt}`).join("\n")
    ),
    section("Request", input.request)
  );

  const result = await retry(
    async (_attempt: number, previousError?: Error) =>
      runtime.llm.structured(
        input.call,
        {
          system,
          user:
            user +
            (previousError
              ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
              : ""),
        },
        schema,
        context
      ),
    2,
    0,
    (error, attempt) =>
      runtime.log.error(
        `[RefineOutline] Attempt ${attempt} failed: ${error.message}`
      )
  );

  const indexOf = new Map(headings.map((h) => [h.heading, h.index]));
  const outline = result.level === "outline";
  return {
    level: result.level,
    why: result.why,
    affected: outline
      ? result.affected.map((a) => ({
          index: indexOf.get(a.heading)!,
          why: a.why,
        }))
      : [],
    sections: new Map(
      outline
        ? result.sections.map((s) => [indexOf.get(s.heading)!, s.text])
        : []
    ),
  };
}
