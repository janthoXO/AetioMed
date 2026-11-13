import z from "zod";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import {
  buildPrompt,
  buildSystemPrompt,
  renderSchemaForPrompt,
  section,
  summarizeValidationError,
} from "@/core/graph/shared/prompt/prompt.js";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

/** Letter fields drafted for AetioReferral's gRPC `RenderLetter` (its `Letter` fields). The rest stays empty on purpose: the chief complaint cannot see the anamnesis, so diagnoses, medication or a patient block could contradict it. */
export const ReferralLetterSchema = z.object({
  sender_name: z
    .string()
    .nullable()
    .describe(
      "Referring physician's name without title, as the content states it; null when it names none"
    ),
  recipient_specialty: z
    .string()
    .min(1)
    .describe("Specialty the patient is referred to, e.g. Cardiology"),
  reason: z
    .string()
    .min(1)
    .describe("The question put to the receiving specialist"),
  urgent: z.boolean(),
  suspected_diagnosis: z
    .string()
    .nullable()
    .describe(
      "Suspected diagnosis exactly as the content states it, worded as a suspicion; null when it states none"
    ),
  history: z
    .string()
    .nullable()
    .describe("Course of the complaint as the referrer reports it"),
  findings: z
    .string()
    .nullable()
    .describe(
      "The referrer's own examination or test results (e.g. vital signs, ECG), never the complaint itself; null when the content states none"
    ),
});
export type ReferralLetter = z.infer<typeof ReferralLetterSchema>;

/**
 * Drafts referral letter fields from planned `alt`s: whole batch in ONE LLM
 * call, in the request language (AetioReferral never translates content).
 * Invents nothing beyond the content.
 */
export async function draftReferralLetters(
  runtime: GraphRuntime,
  language: Language | undefined,
  contents: string[],
  context?: RequestContext
): Promise<ReferralLetter[]> {
  const schema = z.object({
    letters: z
      .array(ReferralLetterSchema)
      .length(contents.length)
      .describe("One letter per content, in the same order"),
  });

  const systemPrompt = buildSystemPrompt(
    language,
    section(
      "Role",
      `You are a referring physician writing referral letters for a medical training simulator.
You will be given one or more contents, each the complete facts of one referral. Fill the letter fields with EXACTLY those facts — you do not decide clinical facts, only wording. A content may be written in a different language than the one you write in; render its meaning.`
    ),

    section(
      "Requirements",
      `- Write as the referring physician's brief referral note (e.g. a general practitioner's hospital referral): reason for referral and relevant findings, and a suspected diagnosis only if the content states one — exactly as given, worded as a suspicion.
- A field the content says nothing about is null; never invent one. "urgent" is true only when the content says so.
- Return exactly ${contents.length} letter(s), in the same order as the contents.
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
      "Contents to render",
      contents.map((content, i) => `### ${i + 1}\n${content}`).join("\n\n")
    )
  );

  console.debug(
    `[DraftReferralLetters] SystemPrompt:\n${systemPrompt}\nUserPrompt:\n${userPrompt}`
  );

  return retry(
    async (attempt: number, previousError?: Error) => {
      const result = await runtime.llm.structured(
        { role: "generator", temperature: "balanced" },
        {
          system: systemPrompt,
          user:
            userPrompt +
            (previousError
              ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
              : ""),
        },
        schema,
        context
      );

      console.debug(
        `[DraftReferralLetters] [Attempt ${attempt}] LLM raw Response:\n`,
        JSON.stringify(result, null, 2)
      );

      return result.letters;
    },
    2,
    0,
    (error, attempt) => {
      const msg = `[DraftReferralLetters] Attempt ${attempt} failed with error: ${error.message}`;
      console.error(msg);
      runtime.log.error(msg);
    }
  );
}
