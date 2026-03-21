import { type Anamnesis } from "@/models/Anamnesis";
import { type ChiefComplaint } from "@/models/ChiefComplaint";
import type { Patient } from "@/models/Patient";
import { type Procedure } from "@/models/Procedure";

export type CaseGenerationResponse = {
  patient?: Patient;
  chiefComplaint?: ChiefComplaint;
  anamnesis?: Anamnesis[];
  procedures?: Procedure[];
};
