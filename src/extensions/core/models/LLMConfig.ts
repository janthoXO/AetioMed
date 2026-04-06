import z from "zod";

export const LLMConfigSchema = z.object({
  provider: z.enum(["ollama", "google"]).optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  url: z.string().url().optional(),
  temperature: z.coerce.number().min(0).max(1).default(0.7),
  outputFormat: z.enum(["json", "text"]).default("json"),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
