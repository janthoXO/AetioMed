import Fuse from "fuse.js";
import fs from "fs";
import path from "path";
import yaml from "yaml";
import type { ICDCode } from "@/02domain-models/Diagnosis.js";

interface DiseaseEntry {
  code: string;
  names: string[];
}

const filepath = path.resolve(import.meta.dirname, "../data/diseases_all.yml");
export const diseases = yaml.parse(
  fs.readFileSync(filepath, "utf-8")
) as DiseaseEntry[];
console.log("[DiseasesService] Loaded diseases from YAML:", diseases);

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
