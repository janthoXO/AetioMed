import { type Anamnesis } from "./Anamnesis";
import { type ChiefComplaint } from "./ChiefComplaint";
import { type Diagnosis } from "./Diagnosis";
import type { GenerationFlag } from "./GenerationFlags";
import { type Procedure } from "./Procedure";

export type Case = {
  id: string;
  diagnosis: Diagnosis;
  createdAt?: Date;
  chiefComplaint?: ChiefComplaint;
  anamnesis?: Anamnesis[];
  procedures?: Procedure[];
  generationFlags: GenerationFlag[];
  language: string;
};
