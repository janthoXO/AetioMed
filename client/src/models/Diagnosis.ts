export const ICDCodePattern = /([A-Z][0-9]{2})(\.[0-9]{1,4})?/;

export type Diagnosis = {
  name: string;
  icd?: string;
}
