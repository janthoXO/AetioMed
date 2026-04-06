import Fuse from "fuse.js";
import { PredefinedDiagnoses, type ICDCode } from "../../core/models/Diagnosis.js";

const fuse = new Fuse(PredefinedDiagnoses, {
  keys: ["name", "alternativeNames"],
  includeScore: true,
  shouldSort: true,
  threshold: 0.4,
});

export async function DiseaseNameToIcd(
  diseaseName: string
): Promise<string | undefined> {
  const normalizedInput = diseaseName.trim();

  const results = fuse.search(normalizedInput);

  if (results.length === 0) {
    return undefined;
  }

  return results[0]?.item.icd;
}

export async function IcdToDiseaseName(
  icdCode: ICDCode
): Promise<string | undefined> {
  const disease = PredefinedDiagnoses.find((d) => d.icd === icdCode);
  if (!disease) {
    return undefined;
  }

  return disease.name;
}
