import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SymptomsRelatedToDiseaseIcd } from "@/02services/symptoms.service.js";
import { ICDCodePattern } from "@/02domain-models/Diagnosis.js";

function SymptomToolFunction(icdCode: string): string {
  console.log(`[Tool: Symptoms] Fetching symptoms for ICD: ${icdCode}`);
  let symptoms = SymptomsRelatedToDiseaseIcd(icdCode);
  if (!symptoms.length) {
    // try to query main icd code
    const match = icdCode.match(ICDCodePattern);
    if (!match) {
      return "No symptoms found for this ICD code.";
    }

    const mainIcdCode = match[1];
    if (!mainIcdCode) {
      return "No symptoms found for this ICD code.";
    }

    console.log(
      `[Tool: Symptoms] No symptoms found for ICD: ${icdCode}, trying main ICD: ${mainIcdCode}`
    );
    symptoms = SymptomsRelatedToDiseaseIcd(mainIcdCode);
    if (!symptoms.length) {
      return "No symptoms found for this ICD code.";
    }
  }

  return symptoms
    .map((s) => `${s.name}${s.description ? `: ${s.description}` : ""}`)
    .join("\n");
}

/**
 * Tool to retrieve symptoms for a given ICD code.
 * Returns the formatted symptoms list string.
 */
export const symptomsTool = tool(
  async ({ icdCode }: { icdCode: string }) => {
    return SymptomToolFunction(icdCode);
  },
  {
    name: "get_symptoms_for_icd",
    description:
      "Retrieves the typical symptoms associated with a specific disease identified by its ICD-10 code.",
    schema: z.object({
      icdCode: z
        .string()
        .describe("The ICD-10 code of the disease (e.g. 'J01.9')"),
    }),
  }
);

export const symptomsToolForICD = (icdCode: string) =>
  tool(
    async () => {
      return SymptomToolFunction(icdCode);
    },
    {
      name: "get_symptoms_for_icd",
      description:
        "Retrieves the typical symptoms associated with a specific disease identified by its ICD-10 code.",
      schema: z.object({}),
    }
  );
