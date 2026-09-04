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
 * Deliberately thin: `llm` exposes one method for now. Modelling per-task
 * LLM *roles* is issue 06's job, not this one's — guessing at that shape
 * here would make 06 a rewrite instead of an extension.
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

/** "Call the model with this config" — the one thing every LLM caller needs. */
export interface LlmPort {
  /** Construct a chat model for the given per-call config, merged over this port's defaults. */
  chat(llmConfig?: Partial<LLMConfig>): BaseChatModel;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
