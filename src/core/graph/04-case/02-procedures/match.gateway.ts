import { retry } from "@/core/graph/shared/prompt/retry.js";
import z from "zod";
import {
  buildPrompt,
  renderSchemaForPrompt,
  section,
} from "@/core/graph/shared/prompt/prompt.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { errorFeedback } from "./prompt.js";

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
        const res = await runtime.llm.structured(
          { role: "judge", temperature: "deterministic" },
          {
            system: systemPrompt,
            user: userPrompt + errorFeedback(previousError),
          },
          MatchSchema,
          context
        );

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
