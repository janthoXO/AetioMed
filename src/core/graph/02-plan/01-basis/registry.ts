import type { GraphRuntime, Logger } from "@/core/graph/runtime.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { SymptomCache, UmlsSymptomFloor } from "./ports.js";
import { createUmlsSymptomProvider } from "@/core/graph/02-plan/01-basis/providers/umlsSymptoms.js";
import { createLlmSymptomProvider } from "@/core/graph/02-plan/01-basis/providers/llmSymptoms.js";
import type {
  BasisFragment,
  BasisQuery,
  MedicalBasisProvider,
} from "./ports.js";

/**
 * Deployment's medical-basis registry: plain list built in composition root,
 * not an env flag. Its size decides whether `basis_resolve` is compiled in
 * (`02-plan/graph.ts`): absent capability = absent node.
 * No deployer switch; always UMLS symptoms, then LLM symptoms (fallback when
 * UMLS has none). Empty registry only
 * reachable by tests or forks.
 */
export function createMedicalBasisRegistry(deps: {
  runtime: GraphRuntime;
  umlsFloor: UmlsSymptomFloor;
  symptomCache: SymptomCache;
}): MedicalBasisProvider[] {
  return [
    createUmlsSymptomProvider(deps.umlsFloor),
    createLlmSymptomProvider(deps.runtime, deps.umlsFloor, deps.symptomCache),
  ];
}

/**
 * Runs all providers concurrently; fragments ordered by **registry index**,
 * not completion order (prompt must be stable run to run). Blank or
 * `undefined` results produce no fragment.
 * Throwing provider: logged, skipped. Hanging provider: bounded by
 * `context.signal`. Context also carries `llmConfig` for `ALLOW_LLMS`.
 */
export async function resolveAllFragments(
  providers: MedicalBasisProvider[],
  query: BasisQuery,
  log: Logger,
  context?: RequestContext
): Promise<BasisFragment[]> {
  const results = await Promise.all(
    providers.map((provider) =>
      provider.fetch(query, context).then(
        (content): BasisFragment[] =>
          content?.trim() ? [{ source: provider.description, content }] : [],
        (error: unknown): BasisFragment[] => {
          log.error(
            `[MedicalBasis] provider "${provider.id}" failed and was skipped: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return [];
        }
      )
    )
  );

  // Promise.all preserves input order, so flat() gives registry order.
  return results.flat();
}
