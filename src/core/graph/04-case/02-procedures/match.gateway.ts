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
      "true only if the proposed name is the true diagnosis, an equivalent name for it, or a more specific form of it; false if it is broader, related, or different"
    ),
  reasoning: z.string().optional().describe("brief explanation"),
});

/**
 * LLM judge, strict and boolean (#214): does the proposed diagnosis name the
 * true one? Synonyms, abbreviations and a more specific form match; a broader
 * term ("ACS" for NSTEMI) does not. Only the boolean leaves this function: a
 * reason (too broad, a finding) would hint at the answer.
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
      `You are a strict medical examiner. Decide whether a proposed final diagnosis is accepted as the true diagnosis.`
    ),

    section(
      "Rules",
      `- Accept (true) when the proposed name is the true diagnosis, a synonym, an abbreviation, an alternative name, or a more specific form of it that is still consistent with it.
- Reject (false) when the proposed name is broader than the true diagnosis (a parent category, e.g. "Acute coronary syndrome" for "NSTEMI", "Diabetes mellitus" for "Type 1 diabetes mellitus").
- Reject (false) when the proposed name is a finding, complication, cause or consequence of the true diagnosis (e.g. "Pneumonia" for "Bronchial carcinoma"), or a different condition.`
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
