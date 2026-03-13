import { config } from "@/config";
import type { Case } from "@/models/Case";
import type { CaseGenerationRequest } from "./dto/case-generation-request";
import type { CaseGenerationResponse } from "./dto/case-generation-response";

export async function fetchCases(): Promise<Case[] | null> {
  try {
    const response = await fetch(config.fetchUrl);
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
  request: CaseGenerationRequest
): Promise<CaseGenerationResponse> {
  const response = await fetch(config.generationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Generation failed: ${response.statusText}`);
  }

  return (await response.json()) as CaseGenerationResponse;
}

