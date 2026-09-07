import { AppError } from "@/core/graph/errors/AppError.js";
import type { ModalityProvider } from "./ports.js";

/**
 * The named startup error for an empty per-field provider list. Thrown by
 * each field's subgraph builder (`02presentation/generation/chiefComplaint/index.ts`,
 * `anamnesis/index.ts`) the moment it is asked to compile against zero
 * providers — which, because every graph variant is compiled eagerly at
 * boot (`caseGraph.ts`'s `buildCaseGraph`), means an empty registry fails
 * the process at startup, not on the first request that happens to need it.
 */
export class EmptyModalityRegistryError extends AppError {
  constructor() {
    super(
      "Modality registry is empty — at least one ModalityProvider (e.g. a text provider) must be registered.",
      "EMPTY_MODALITY_REGISTRY",
      500
    );
  }
}

/**
 * Which content-bearing field a provider list serves (issue 21 §4).
 * Providers are per field — chief complaint may have a PDF transfer-slip
 * provider that anamnesis has no use for — so there is no longer a single
 * flat registry, only one array per field.
 */
export type ModalityField = "chiefComplaint" | "anamnesis" | "procedureResult";

/**
 * The deployment's complete set of per-field registries, composed in the
 * composition root (`graph/index.ts`) from each field's own
 * `create*Providers(runtime)` factory (`chiefComplaint/providers.ts`,
 * `anamnesis/providers.ts`; `procedureResult` is wired by a later step —
 * see that key's TODO in `graph/index.ts`). Still `AssemblyDeps`, not
 * `GraphFlags`, in `caseGraph.ts` — fixed per deployment, shared by all four
 * flag variants, for the same reason `medicalBasisRegistry` lives there.
 */
export type ModalityRegistries = Record<
  ModalityField,
  ModalityProvider<unknown>[]
>;

/**
 * Look up a provider by `id` — the plan addresses providers by id (never by
 * MIME type, since two providers in the same field could share a MIME and
 * the plan must pick a specific one).
 */
export function findModalityProvider(
  providers: ModalityProvider<unknown>[],
  id: string
): ModalityProvider<unknown> | undefined {
  return providers.find((p) => p.id === id);
}
