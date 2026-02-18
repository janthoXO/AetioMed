import Fuse from "fuse.js";
import diseasesData from "../data/diseases_all.json" with { type: "json" };
import type { ICDCode } from "@/02domain-models/Diagnosis.js";

interface DiseaseEntry {
  code: string;
  names: string[];
}

const diseases = diseasesData as DiseaseEntry[];

const fuse = new Fuse(diseases, {
  keys: ["names"],
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

  return results[0]?.item.code;
}

export async function IcdToDiseaseName(
  icdCode: ICDCode
): Promise<string | undefined> {
  const disease = diseases.find((d) => d.code === icdCode);
  if (!disease) {
    return undefined;
  }

  return disease.names[0];
}
