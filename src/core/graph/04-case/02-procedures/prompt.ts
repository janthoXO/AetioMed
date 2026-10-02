import {
  renderForPrompt,
  section,
  summarizeValidationError,
} from "@/core/graph/shared/prompt/prompt.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import { type ProcedureRelevance } from "@/core/graph/shared/domain/Procedure.js";
import { type ProcedureRef } from "@/core/graph/shared/domain/ProcedureTree.js";
import type { Patient } from "@/core/graph/shared/domain/Patient.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

/**
 * Patient presentation as seen by blinded solver, no diagnosis. Text
 * projection, not domain `Case`: bytes never reach a prompt. Built only by
 * `presentationOf` (`graph.ts`) via `altOf`.
 */
export type Presentation = {
  patient?: Patient | undefined;
  chiefComplaint?: string | undefined;
  anamnesis?: { category: string; answer: string }[] | undefined;
};

export type BlindedProcedureStepResult =
  | {
      action: "procedure";
      procedures?: ProcedureRef[] | undefined;
      reasoning?: string | undefined;
    }
  | {
      action: "diagnose";
      diagnosisName?: string | undefined;
      reasoning?: string | undefined;
    };

// ─── Shared prompt sections ───────────────────────────────────────────────────

/**
 * Blinded solver's (and bridge's) view of an ordered procedure, projected from
 * `plannedProcedures`: `result` is `parts.map(p => p.alt).join("\n\n")`.
 * Nothing rendered yet, so `alt` (see `planProcedureResults`) is all there is.
 */
export type PreviousProcedureFinding = {
  path: string[];
  name: string;
  relevance: ProcedureRelevance;
  result: string;
};

export function presentationSection(presentation: Presentation) {
  return section("Patient presentation", renderForPrompt(presentation));
}

export function diagnosisLabel(diagnosis: Diagnosis) {
  return `${diagnosis.name}${diagnosis.icd ? ` (${diagnosis.icd})` : ""}`;
}

export function errorFeedback(previousError: Error | undefined) {
  return previousError
    ? `\n\nPrevious generation error: ${summarizeValidationError(previousError)}`
    : "";
}
