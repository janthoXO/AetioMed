import { AppError } from "@/core/graph/errors/AppError.js";
import { createTextModalityProvider } from "./providers/text.js";
import type { ModalityProvider } from "./ports.js";

/**
 * The named startup error for §4's "registry size 0" row. Thrown by the
 * field-content pipeline (`pipeline.ts`'s `buildContentPartsSubgraph`) the
 * moment it is asked to compile against an empty registry — which, because
 * every graph variant is compiled eagerly at boot (`caseGraph.ts`'s
 * `buildCaseGraph`), means an empty registry fails the process at startup,
 * not on the first request that happens to need it.
 */
export class EmptyModalityRegistryError extends AppError {
  constructor() {
    super(
      "Modality registry is empty — at least one ModalityProvider (e.g. the text provider) must be registered.",
      "EMPTY_MODALITY_REGISTRY",
      500
    );
  }
}

/**
 * Builds the deployment's modality registry: a plain list constructed in
 * the composition root, **not** a compile-time flag — exactly
 * `medicalBasis/registry.ts`'s `createMedicalBasisRegistry` (see that
 * module's doc comment for the reasoning this mirrors). The registry's
 * *size* decides whether `decide_modality` is compiled into each field
 * subgraph at all (`02presentation/generation/pipeline.ts`), the same
 * absent-capability-⇒-absent-node rule as the two graph flags and the
 * medical-basis registry, just driven by this list's length instead of a
 * boolean.
 *
 * There is no deployer-facing switch for this list today — it always
 * returns `[textProvider]`. An image (or audio, or any other non-text)
 * provider slots in here without touching any graph.
 */
export function createModalityRegistry(): ModalityProvider[] {
  return [createTextModalityProvider()];
}

/** First provider (in registry order) that declares it can produce `mime`. */
export function findModalityProvider(
  providers: ModalityProvider[],
  mime: string
): ModalityProvider | undefined {
  return providers.find((p) => p.produces.includes(mime));
}

/** Every MIME type any registered provider can produce, deduped, registry order. */
export function producibleModalities(providers: ModalityProvider[]): string[] {
  return [...new Set(providers.flatMap((p) => p.produces))];
}
