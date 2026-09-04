import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LLMConfig } from "./models/LLMConfig.js";
import type {
  AnamnesisCatalog,
  ProcedureCatalog,
  LabelCatalog,
  DiagnosisCatalog,
} from "./catalog/ports.js";

/**
 * The single seam graph construction goes through. Ports are captured by
 * closure at graph-assembly time (see `02graphs/caseGraph.ts` and friends) —
 * not threaded through every node's call signature, and not carried on
 * LangGraph's per-invocation runtime context (`RequestContextSchema` is a
 * Zod schema LangGraph validates; putting port *functions* there would mean
 * loosening it to `z.custom`, and ALS-carried ports are invisible to
 * checkpoints — see `utils/context.ts`).
 *
 * `llm` models two independent dimensions per issue 06: *role* (who is
 * asking — generator/judge/translator, each independently configurable so a
 * deployer can run a small local generator against a stronger judge) and
 * *temperature* (a fixed policy class, not configuration — see
 * `utils/llm.ts`).
 */
export interface GraphRuntime {
  llm: LlmPort;
  catalogs: {
    procedures: ProcedureCatalog;
    anamnesis: AnamnesisCatalog;
    labels: LabelCatalog;
    diagnosis: DiagnosisCatalog;
  };
  /** info/warn/error — stamps the timestamp (via `clock`) and emits the bus event. */
  log: Logger;
  /** So tests can freeze time. */
  clock: () => Date;
}

export const LLM_ROLES = ["generator", "judge", "translator"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/** Policy classes, not configuration. See `utils/llm.ts` for the values. */
export type LlmTemperature = "deterministic" | "balanced" | "creative";

/** "Call the model for this role/temperature" — the one thing every LLM caller needs. */
export interface LlmPort {
  /**
   * Construct a chat model for the given role and temperature class,
   * overridden by the given per-call `llmConfig` (e.g. a request's
   * `ALLOW_LLMS` selection).
   */
  for(
    opts: { role: LlmRole; temperature: LlmTemperature },
    llmConfig?: Partial<LLMConfig>
  ): BaseChatModel;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
