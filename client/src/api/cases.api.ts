import { config } from "@/config";
import type { Case } from "@/models/Case";
import type { CaseGenerationRequest } from "./dto/case-generation-request";
import type { CaseGenerationResponse } from "./dto/case-generation-response";
import { z } from "zod";

const PatientSchema = z.object({
  name: z.string(),
  age: z.number(),
  height: z.number(),
  weight: z.number(),
  gender: z.enum(["male", "female"]),
  race: z.string().optional(),
});

const AnamnesisSchema = z.object({
  category: z.string(),
  answer: z.string(),
});

const ProcedureSchema = z.object({
  name: z.string(),
  relevance: z.string(),
});

export const CaseGenerationResponseSchema = z.object({
  patient: PatientSchema.optional(),
  chiefComplaint: z.string().optional(),
  anamnesis: z.array(AnamnesisSchema).optional(),
  procedures: z.array(ProcedureSchema).optional(),
});

export async function fetchCases(signal?: AbortSignal): Promise<Case[] | null> {
  try {
    const response = await fetch(config.fetchUrl, { signal });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data as Case[];
  } catch {
    return null;
  }
}

export async function generateCase(
  request: CaseGenerationRequest,
  signal?: AbortSignal
): Promise<CaseGenerationResponse> {
  const response = await fetch(config.generationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Generation failed: ${response.statusText}`);
  }

  const data = await response.json();
  return CaseGenerationResponseSchema.parse(data);
}
