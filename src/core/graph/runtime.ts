import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LLMConfig } from "./models/LLMConfig.js";
import type { Language } from "./models/Language.js";
import type {
  AnamnesisCatalog,
  ProcedureCatalog,
  LabelCatalog,
  DiagnosisCatalog,
} from "./catalog/ports.js";

/**
 * Single seam graph construction goes through. Ports captured by closure at
 * graph-assembly time, not node signatures or LangGraph runtime context.
 *
 * `llm` has two independent dimensions: *role* (generator/judge/translator,
 * each configurable) and *temperature* (fixed policy class, see `utils/llm.ts`).
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
  /**
   * Overrides language `buildSystemPrompt` uses for `"user-facing"` prompts
   * instead of ambient ALS language. Bound at graph-assembly time per compiled
   * variant, never per request. `assembleCaseGraph` sets `"English"` for the
   * generation phase when sandwich compiled in; translate-out uses the
   * unmodified runtime.
   */
  languageOverride?: Language;
}

export const LLM_ROLES = ["generator", "judge", "translator"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/** Policy classes, not configuration. See `utils/llm.ts` for the values. */
export type LlmTemperature = "deterministic" | "balanced" | "creative";

/** "Call the model for this role/temperature" — the one thing every LLM caller needs. */
export interface LlmPort {
  /** Chat model for role + temperature class, overridden by per-call `llmConfig` (e.g. `ALLOW_LLMS` pick). */
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
