import type { Config } from "./config.js";
import type { GraphRuntime } from "./runtime.js";
import type { Case } from "./models/Case.js";
import type { Diagnosis } from "./models/Diagnosis.js";
import type { GenerationFlag } from "./models/GenerationFlags.js";
import type { UserInstructions } from "./models/UserInstructions.js";
import type { Language } from "./models/Language.js";
import type { Difficulty } from "./models/Difficulty.js";

export type GenerateCaseFn = (
  diagnosis: Diagnosis,
  generationFlags: GenerationFlag[],
  userInstructions?: UserInstructions,
  language?: Language,
  difficulty?: Difficulty
) => Promise<Case>;

/**
 * The case-generation graph's surface, as consumed by transport extensions
 * (rest, nats). Built once in `app.ts`'s `createApp()` and handed to every
 * extension's `setup()` via `ExtensionSetupCtx.graph` — extensions never
 * import graph internals (there is no longer a module singleton to import).
 */
export interface GraphAppContext {
  config: Config;
  runtime: GraphRuntime;
  generateCase: GenerateCaseFn;
}
