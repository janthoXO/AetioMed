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

/** Patient presentation fields: everything the blinded solver reasons from (`presentationOf`). */
export const PresentationGenerationFlags: GenerationFlag[] = [
  "patient",
  "chiefComplaint",
  "anamnesis",
];

/**
 * `["procedures"]` alone is valid, but blinded solver needs a presentation.
 * Presentation fields generated **internally**, projected out by
 * {@link projectCaseToFlags}; caller gets only requested fields.
 *
 * Do not reuse the plan outline as presentation: its fixed procedures
 * section describes how results reach the diagnosis (`case.aigateway.ts`
 * instruction 4); slicing by heading risks leaking it into the *blinded* solver.
 */
export function expandFlagsForSolver(
  flags: GenerationFlag[]
): GenerationFlag[] {
  const needsPresentation =
    flags.includes("procedures") &&
    !flags.some((flag) => PresentationGenerationFlags.includes(flag));

  return needsPresentation ? [...flags, ...PresentationGenerationFlags] : flags;
}

/** Drop fields not requested. Flag names are `Case` keys: straight key filter. */
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
