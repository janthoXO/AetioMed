import type { GenerationFlag } from "../../models/GenerationFlags";

export type CaseGenerationRequest = {
  icd?: string;
  diagnosis: string;
  context?: Record<GenerationFlag & "general", string>;
  generationFlags: GenerationFlag[];
  language?: string;
  traceId?: string;
};
