import type { Config } from "./config.js";
import type { GraphRuntime } from "./runtime.js";
import type { Case } from "./models/Case.js";
import type { Diagnosis } from "./models/Diagnosis.js";
import type { GenerationFlag } from "./models/GenerationFlags.js";
import type { UserInstructions } from "./models/UserInstructions.js";
import type { Language } from "./models/Language.js";
import type { Difficulty } from "./models/Difficulty.js";

export type GenerateCaseFn = (opts: {
  diagnosis: Diagnosis;
  generationFlags: GenerationFlag[];
  userInstructions?: UserInstructions | undefined;
  language?: Language | undefined;
  difficulty?: Difficulty | undefined;
  /**
   * Whether the caller actually supplied free text — a diagnosis name
   * (rather than only an `icd`) or any `userInstructions` (issue 12 §3).
   * `CaseGenerationService` is the only place that knows this, since it
   * performs the ICD→name resolution before calling in.
   */
  callerSuppliedFreeText: boolean;
}) => Promise<Case>;

/**
 * The case-generation graph's surface, as consumed by the transports (rest,
 * nats). Built once in `app.ts`'s `createApp()` and handed explicitly to
 * each transport's start function (`startRestServer`, `startNatsTransport`)
 * — transports never import graph internals (there is no module singleton
 * to import).
 */
export interface GraphAppContext {
  config: Config;
  runtime: GraphRuntime;
  generateCase: GenerateCaseFn;
}
