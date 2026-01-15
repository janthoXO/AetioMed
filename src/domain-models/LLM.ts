import z from "zod";

export const LLMProviderSchema = z.enum(["ollama"]);

export type LLMProvider = z.infer<typeof LLMProviderSchema>;
