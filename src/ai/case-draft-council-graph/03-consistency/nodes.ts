import { type ConsistencyState } from "./state.js";
import { GenerationError } from "@/errors/AppError.js";
import { generateInconsistenciesOneShot } from "@/services/consistency.service.js";

type GenerateInconsistenciesOutput = Pick<ConsistencyState, "inconsistencies">;
/**
 * Generates inconsistencies for the given case draft.
 */
export async function generateInconsistencies(
  state: ConsistencyState
): Promise<GenerateInconsistenciesOutput> {
  console.debug(
    "[Consistency: GenerateInconsistencies] Generating inconsistencies for case"
  );

  if (!state.case) {
    throw new GenerationError("Case is missing for consistency check");
  }

  return {
    inconsistencies: await generateInconsistenciesOneShot(
      state.case,
      state.diagnosis,
      state.context
    ),
  };
}
