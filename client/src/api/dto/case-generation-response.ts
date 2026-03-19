import { type Anamnesis } from "@/models/Anamnesis";
import { type ChiefComplaint } from "@/models/ChiefComplaint";
import { type Procedure } from "@/models/Procedure";

export type CaseGenerationResponse = {
  chiefComplaint?: ChiefComplaint;
  anamnesis?: Anamnesis[];
  procedures?: Procedure[];
};
