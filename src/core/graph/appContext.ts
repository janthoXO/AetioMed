import type { Config } from "./config.js";
import type { GraphRuntime } from "./runtime.js";
import type { DbHandle } from "./persistence/db.js";
import type { Case } from "./models/Case.js";
import type { Diagnosis } from "./models/Diagnosis.js";
import type { GenerationFlag } from "./models/GenerationFlags.js";
import type { UserInstructions } from "./models/UserInstructions.js";
import type { Language } from "./models/Language.js";
import type { Difficulty } from "./models/Difficulty.js";
import type {
  CompiledCaseGraphs,
  PlanCaseInput,
  PlanResult,
  RenderCaseInput,
} from "./02graphs/caseGraph.js";

export type { PlanCaseInput, PlanResult, RenderCaseInput };

export type GenerateCaseFn = (opts: {
  diagnosis: Diagnosis;
  generationFlags: GenerationFlag[];
  userInstructions?: UserInstructions | undefined;
  language?: Language | undefined;
  difficulty?: Difficulty | undefined;
  /**
   * Caller supplied free text: diagnosis name (not just `icd`) or any
   * `userInstructions`. Only `CaseGenerationService` knows; it does ICD→name
   * resolution first.
   */
  callerSuppliedFreeText: boolean;
}) => Promise<Case>;

/**
 * Graph surface consumed by transports. Built once in `createApp()`, passed
 * to each transport start function. Transports never import graph internals.
 */
export interface GraphAppContext {
  config: Config;
  runtime: GraphRuntime;
  /** For `app.ts` only: registered as last shutdown closer. Transports must not touch it. */
  db: DbHandle;
  /** Run plan graph only: outline + judge loop, plus working-language inputs the case graph needs. */
  planCase: (opts: PlanCaseInput) => Promise<PlanResult>;
  /** Run the case graph only, from an outline {@link planCase} produced. */
  renderCase: (opts: RenderCaseInput) => Promise<Case>;
  /**
   * Translate outline values keyed by segment index: `"out"` to request
   * language, `"in"` to English. Only when sandwich compiled in.
   */
  translateOutline:
    | ((
        values: Record<string, string>,
        direction: "out" | "in"
      ) => Promise<Record<string, string>>)
    | undefined;
  /**
   * Compiled plan + case graphs this deployment serves (deployer's flag
   * variant). Consumed by `GET /api/graph` (`structure.ts`) via
   * `getGraphAsync({ xray: true })`, same call as `02graphs/exportGraphs.ts`.
   */
  graphs: CompiledCaseGraphs;
}
