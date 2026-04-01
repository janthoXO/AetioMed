import { type Anamnesis } from "./Anamnesis";
import { type ChiefComplaint } from "./ChiefComplaint";
import { type Diagnosis } from "./Diagnosis";
import type { GenerationFlag } from "./GenerationFlags";
import { type Procedure } from "./Procedure";
import { type Patient } from "./Patient";

export type BackendCase = {
  patient?: Patient;
  chiefComplaint?: ChiefComplaint;
  anamnesis?: Anamnesis[];
  procedures?: Procedure[];
};

export type LLMConfig = {
  provider: string;
  model: string;
  apiKey: string;
  url: string;
};

export type CaseRun = {
  runId: number;
  llmConfig?: LLMConfig;
  status: "generating" | "complete" | "error";
  error?: string;
  traceId?: string;
  caseId: number;
} & BackendCase;

export type Case = {
  id: number;
  diagnosis: Diagnosis;
  createdAt: Date;
  generationFlags: GenerationFlag[];
  language: string;
  runs: CaseRun[];
};
