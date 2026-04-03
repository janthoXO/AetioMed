import z from "zod";

export const LLMProviderSchema = z.enum(["ollama", "google"]);

export type LLMProvider = z.infer<typeof LLMProviderSchema>;

export const LLMConfigSchema = z.object({
  provider: LLMProviderSchema,
  model: z.string(),
  apiKey: z.string().optional(),
  url: z.url().optional(),
  temperature: z.coerce.number().min(0).max(1).default(0.7),
  outputFormat: z.enum(["json", "text"]).default("json"),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
