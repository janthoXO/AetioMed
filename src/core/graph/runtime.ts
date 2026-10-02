import type { z } from "zod";
import type { RequestContext } from "./utils/context.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
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
 * each configurable) and *temperature* (fixed policy class, see `adapters/ai/llm.ts`).
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
   * Language user-facing prompts write in (`boundLanguage`), instead of ambient
   * ALS language. Bound at graph-assembly time per compiled
   * variant, never per request. `assembleCaseGraph` sets `"English"` for the
   * generation phase when sandwich compiled in; translate-out uses the
   * unmodified runtime.
   */
  languageOverride?: Language;
  /** Web search; absent when the deployment configures none. */
  webSearch?: WebSearch;
}

export type WebSearchResult = { title: string; url: string; content: string };

export type WebSearch = (
  query: string,
  context?: RequestContext
) => Promise<WebSearchResult[]>;

/** A tool an agent call may use. Result is plain text fed back to the model. */
export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  run(input: unknown, context?: RequestContext): Promise<string>;
}

export const LLM_ROLES = ["generator", "judge", "translator"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/** Policy classes, not configuration. See `adapters/ai/llm.ts` for the values. */
export type LlmTemperature = "deterministic" | "balanced" | "creative";

/** "Call the model for this role/temperature, get a schema-valid object back" — the one thing every LLM caller needs. */
export interface LlmPort {
  /**
   * One structured-output call: system + user message, parsed against `schema`. Per-call `context`
   * carries the `llmConfig` override (`ALLOW_LLMS` pick) and the abort signal.
   */
  structured<T>(
    call: { role: LlmRole; temperature: LlmTemperature },
    prompt: { system: string; user: string },
    schema: z.ZodType<T>,
    context?: RequestContext
  ): Promise<T>;
  /** One free-text call (no structured output); returns the message text. */
  text(
    call: { role: LlmRole; temperature: LlmTemperature },
    prompt: { system: string; user: string },
    context?: RequestContext
  ): Promise<string>;
  /**
   * Free-text call in a tool-calling loop: the model may call `tools` up to
   * `maxSteps` rounds, then must answer. Returns the final message text.
   */
  agent(
    call: { role: LlmRole; temperature: LlmTemperature },
    prompt: { system: string; user: string },
    tools: AgentTool[],
    opts: { maxSteps: number },
    context?: RequestContext
  ): Promise<string>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
