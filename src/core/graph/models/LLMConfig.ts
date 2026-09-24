import z from "zod";

/** Per-call model selection. **No** temperature: fixed policy class from call site (`LlmPort.for`, `utils/llm.ts`). */
export const LLMConfigSchema = z.object({
  provider: z.enum(["ollama", "google", "openai"]),
  model: z.string(),
  apiKey: z.string().optional(),
  url: z.url().optional(),
  outputFormat: z.enum(["json", "text"]).default("json"),
  /** Hidden reasoning phase: `false` suppresses, `true` forces, `undefined` server default. Ignored by `google`. */
  enableThinking: z.boolean().optional(),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
