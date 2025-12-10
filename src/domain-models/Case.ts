import type { AnamnesisField } from "./Anamnesis.js";

export interface Case {
  treatmentReason?: string;
  anamnesis?: AnamnesisField[];
}