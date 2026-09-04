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
 * Migrated verbatim from the former `02case-generation/01symptom/`
 * `symptoms_resolve` node (issue 14): reads the static UMLS floor for the
 * diagnosis's ICD code (`symptomsRepo.SymptomsRelatedToDiagnosisIcd`), then
 * resolves LLM-generated additions cache-aside with the same TTL — a fresh
 * cache hit skips the LLM entirely, and a diagnosis without an ICD code is
 * never cached. Same log lines as the old node, prefixed for this slice.
 *
 * Collapses the resulting symptom union into a single fragment instead of
 * returning it on graph state.
 *
 * Receives the full `RequestContext` — not just an abort signal — because a
 * cold cache miss makes an LLM call, and under `ALLOW_LLMS` the request's
 * `llmConfig` is the only source of provider/model. See `../ports.ts`.
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

      // Always emits exactly one fragment — even with an empty symptom list
      // — mirroring the old node's unconditional `{ symptoms: [...] }`
      // return, so the rendered section's presence never depends on content.
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
