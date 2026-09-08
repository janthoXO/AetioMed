import z from "zod";
import type { Case } from "./Case.js";

export const GenerationFlagSchema = z.enum([
  "patient",
  "chiefComplaint",
  "anamnesis",
  "procedures",
]);

export type GenerationFlag = z.infer<typeof GenerationFlagSchema>;

export const AllGenerationFlags: GenerationFlag[] =
  GenerationFlagSchema.options;

/**
 * The fields that make up the patient presentation — everything the blinded
 * procedure solver reasons from (`03procedure/index.ts`'s `presentationOf`).
 */
export const PresentationGenerationFlags: GenerationFlag[] = [
  "patient",
  "chiefComplaint",
  "anamnesis",
];

/**
 * `generationFlags: ["procedures"]` alone is a valid request, but the blinded
 * solver cannot work from an empty presentation — it would be handed a
 * patient with no age, no complaint and no history, after the plan and its
 * judge loop had already been paid for.
 *
 * So the presentation is generated **internally** and then projected back out
 * of the response by {@link projectCaseToFlags}. The caller gets exactly the
 * fields they asked for; the solver gets exactly the input it gets today.
 *
 * The obvious cheaper alternative — reusing the plan outline as the solver's
 * presentation — is *not* safe. `state.outline` is a free-text markdown
 * string that, by `case.aigateway.ts`'s own instruction 4, contains a
 * "Workup / Procedure Results Strategy" section describing how results should
 * be shaped to reach the diagnosis. Slicing a presentation out of it by
 * heading is a parse whose failure mode is silently leaking that strategy
 * into the *blinded* solver — destroying the pipeline's core asymmetry while
 * still producing plausible output. Doing it properly means giving the plan a
 * structured, blinded-safe presentation summary, which is a change to the
 * most sensitive prompt in the pipeline and belongs in its own change.
 *
 * The honest cost of the approach taken here: three presentation fields are
 * generated and discarded. That is still strictly less waste than the
 * behaviour it replaces, which paid for the plan *and* its evaluations and
 * then solved against nothing.
 */
export function expandFlagsForSolver(
  flags: GenerationFlag[]
): GenerationFlag[] {
  const needsPresentation =
    flags.includes("procedures") &&
    !flags.some((flag) => PresentationGenerationFlags.includes(flag));

  return needsPresentation ? [...flags, ...PresentationGenerationFlags] : flags;
}

/**
 * Drop any field the caller did not ask for. The flag names are the `Case`
 * keys, so this is a straight key filter — keep it that way.
 */
export function projectCaseToFlags(
  generatedCase: Case,
  flags: GenerationFlag[]
): Case {
  return Object.fromEntries(
    Object.entries(generatedCase).filter(([key]) =>
      flags.includes(key as GenerationFlag)
    )
  ) as Case;
}
