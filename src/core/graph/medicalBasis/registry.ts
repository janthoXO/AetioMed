import type { GraphRuntime, Logger } from "@/core/graph/runtime.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { SymptomsRepo } from "@/core/graph/symptoms/repo.js";
import { createUmlsSymptomProvider } from "./providers/umlsSymptoms.js";
import type {
  BasisFragment,
  BasisQuery,
  MedicalBasisProvider,
} from "./ports.js";

/**
 * Deployment's medical-basis registry: plain list built in composition root,
 * not an env flag. Its size decides whether `basis_resolve` is compiled in
 * (`02case-generation/index.ts`): absent capability = absent node.
 * No deployer switch; always `[umlsSymptomProvider]`. Empty registry only
 * reachable by tests or forks.
 */
export function createMedicalBasisRegistry(deps: {
  runtime: GraphRuntime;
  symptomsRepo: SymptomsRepo;
}): MedicalBasisProvider[] {
  return [createUmlsSymptomProvider(deps.runtime, deps.symptomsRepo)];
}

/**
 * Runs all providers concurrently; fragments ordered by **registry index**,
 * not completion order (prompt must be stable run to run).
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
      provider.fetch(query, context).catch((error: unknown) => {
        log.error(
          `[MedicalBasis] provider "${provider.id}" failed and was skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return [] as BasisFragment[];
      })
    )
  );

  // Promise.all preserves input order, so flat() gives registry order.
  return results.flat();
}
