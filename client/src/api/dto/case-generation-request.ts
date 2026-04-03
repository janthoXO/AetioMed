import type { GenerationFlag } from "../../models/GenerationFlags";
import type { LLMConfig } from "../../models/Case";

export type CaseGenerationRequest = {
  icd?: string;
  diagnosis?: string;
  userInstructions?: Record<GenerationFlag | "general", string>;
  generationFlags: GenerationFlag[];
  language?: string;
  traceId?: string;
  llmConfig?: LLMConfig;
  anamnesisCategories?: string[];
};
