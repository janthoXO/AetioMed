import z from "zod";

export const LLMConfigSchema = z.object({
  provider: z.enum(["ollama", "google", "openai"]),
  model: z.string(),
  apiKey: z.string().optional(),
  url: z.url().optional(),
  temperature: z.coerce.number().min(0).max(1).default(0.7),
  outputFormat: z.enum(["json", "text"]).default("json"),
  /**
   * Controls the model's hidden "thinking"/reasoning phase on providers that
   * support it. `false` suppresses it (fast), `true` forces it on, `undefined`
   * leaves the server default. Ignored by the `google` provider.
   */
  enableThinking: z.boolean().optional(),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
