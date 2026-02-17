import z from "zod";

export const LLMProviderSchema = z.enum(["ollama", "google"]);

export type LLMProvider = z.infer<typeof LLMProviderSchema>;
