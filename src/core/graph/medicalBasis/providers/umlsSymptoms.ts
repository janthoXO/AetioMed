import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { SymptomsRepo } from "@/core/graph/symptoms/repo.js";
import { generateSymptomsOneShot } from "@/core/graph/03aigateway/symptoms.aigateway.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type {
  BasisFragment,
  BasisQuery,
  MedicalBasisProvider,
} from "../ports.js";

const SOURCE_ID = "umls-symptoms";

/**
 * Static UMLS floor for the diagnosis's ICD code, unioned with LLM-generated
 * additions (cache-aside; fresh hit skips LLM; no ICD code = never cached).
 * Collapsed into one fragment. Needs full `RequestContext` for `llmConfig`
 * on cache miss. See `../ports.ts`.
 */
export function createUmlsSymptomProvider(
  runtime: GraphRuntime,
  symptomsRepo: SymptomsRepo
): MedicalBasisProvider {
  return {
    id: SOURCE_ID,
    async fetch(
      query: BasisQuery,
      context?: RequestContext
    ): Promise<BasisFragment[]> {
      const icd = query.diagnosis.icd;
      const umls = icd ? symptomsRepo.SymptomsRelatedToDiagnosisIcd(icd) : [];

      runtime.log.info(
        `[MedicalBasis:${SOURCE_ID}] UMLS symptoms: ${
          umls.length > 0 ? umls.map((s) => s.name).join(", ") : "none"
        }`
      );

      const cached = icd ? symptomsRepo.getCachedSymptoms(icd) : undefined;

      let symptoms: typeof umls;
      if (cached) {
        runtime.log.info(
          `[MedicalBasis:${SOURCE_ID}] cache hit for ICD ${icd}: ${cached.map((s) => s.name).join(", ")}`
        );
        symptoms = [...umls, ...cached];
      } else {
        const generated = await generateSymptomsOneShot(
          runtime,
          query.diagnosis,
          query.userInstructions,
          umls,
          context
        );

        runtime.log.info(
          `[MedicalBasis:${SOURCE_ID}] cache miss${icd ? ` for ICD ${icd}` : ""}, LLM symptoms: ${generated.map((s) => s.name).join(", ")}`
        );

        if (icd) {
          symptomsRepo.saveCachedSymptoms(icd, generated);
        }

        symptoms = [...umls, ...generated];
      }

      // Always one fragment, even with empty symptoms: section presence never depends on content.
      return [
        {
          sourceId: SOURCE_ID,
          label: "Typical symptoms",
          content: symptoms.map((s) => s.name).join(", "),
          retrievedAt: runtime.clock().toISOString(),
        },
      ];
    },
  };
}
