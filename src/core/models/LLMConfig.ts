import { config } from "@/config.js";
import z from "zod";

export const LLMConfigSchema = z.object({
  provider: config.llm
    ? z.enum([config.llm.provider])
    : z.enum(Object.keys(config.allowedLlms!)),
  model: config.llm
    ? z.enum([config.llm.model])
    : z.enum(Object.values(config.allowedLlms!).flat()),
  apiKey: z.string().optional(),
  url: z.url().optional(),
  temperature: z.coerce.number().min(0).max(1).default(0.7),
  outputFormat: z.enum(["json", "text"]).default("json"),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
