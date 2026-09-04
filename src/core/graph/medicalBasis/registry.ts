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
 * Builds the deployment's medical-basis registry: a plain list constructed
 * in the composition root, **not** a compile-time flag.
 * `docs/architecture-target.md` §4.1 fixes the deployer-facing flag count at
 * two (`TRANSLATION_SANDWICH`, `PROCEDURE_PRESELECTION`); a third env flag
 * for this would contradict it directly. The registry's *size* decides
 * whether `basis_resolve` is compiled into the graph at all
 * (`02case-generation/index.ts`) — the same absent-capability-⇒-absent-node
 * rule as the two graph flags, just driven by a list length instead of a
 * boolean.
 *
 * There is no deployer-facing switch for this list today — it always
 * returns `[umlsSymptomProvider]`. The empty-registry path this makes
 * possible is reachable by tests and by a fork constructing its own registry
 * with nothing registered, not by an operator flipping an env var. A
 * config-file-driven registry (reading provider config from `CATALOG_DIR`,
 * say) is exactly the "option B" `docs/architecture-target.md` §4.1 already
 * anticipates for extending this further, and would slot in here without
 * touching the graph.
 */
export function createMedicalBasisRegistry(deps: {
  runtime: GraphRuntime;
  symptomsRepo: SymptomsRepo;
}): MedicalBasisProvider[] {
  return [createUmlsSymptomProvider(deps.runtime, deps.symptomsRepo)];
}

/**
 * Runs every provider in the registry concurrently, then reorders the
 * resulting fragments by **registry index**, not completion order —
 * otherwise the plan prompt would vary run to run for the same registry,
 * which makes evaluation meaningless (see `registry.test.ts`'s staggered
 * fake-provider test, where the first-registered provider resolves last but
 * its fragment still lands first).
 *
 * A provider that throws is logged and skipped, never fatal: one bad source
 * must not fail the whole generation. A provider that hangs is bounded by
 * `context.signal` — the request's `AbortSignal`, which reaches this
 * function exactly the way every other node gets it (`lgRuntime?.context`,
 * see `02case-generation/index.ts`). The context also carries `llmConfig`,
 * which a provider making an LLM call needs under `ALLOW_LLMS`.
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

  // `results[i]` corresponds to `providers[i]` by construction (Promise.all
  // preserves input order regardless of resolution order), so flattening in
  // this order is what gives registry-order concatenation.
  return results.flat();
}
