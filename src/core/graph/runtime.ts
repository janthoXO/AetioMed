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
  /**
   * Overrides the language `buildSystemPrompt` (`utils/prompt.ts`) uses for
   * `"user-facing"` prompts, in place of the per-request ambient language
   * (`getRequestContext()?.language`, ALS). Bound once at graph-assembly
   * time, per compiled variant — never mutated per request; this is what
   * "language is a property of the bound ports" (issue 09 §2) means for the
   * generation phase specifically.
   *
   * The one binding today: `assembleCaseGraph` (`02graphs/caseGraph.ts`)
   * hands the generation phase a runtime with `languageOverride: "English"`
   * whenever the translation sandwich is compiled in — generation always
   * runs in English in that topology (issue 09 §3/§4), regardless of the
   * request's real target language, which only ever reaches the
   * translate-out phase (built from the *unmodified* runtime).
   */
  languageOverride?: Language;
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
