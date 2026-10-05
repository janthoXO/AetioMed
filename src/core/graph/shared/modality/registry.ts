import { AppError } from "@/core/graph/errors/AppError.js";
import type { ModalityProvider } from "./ports.js";

/**
 * Empty per-field provider list. Thrown by each field's subgraph builder
 * (`chiefComplaint/index.ts`, `anamnesis/index.ts`) at compile; variants
 * compile eagerly at boot, so this fails startup, not first request.
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

/** Content-bearing field a provider list serves. Providers are per field, one array each. */
export type ModalityField = "chiefComplaint" | "anamnesis" | "procedureResult";

/**
 * Per-field registries, composed in `graph/index.ts` from each field's
 * `create*Providers(runtime)`. Lives in `AssemblyDeps`, not `GraphFlags`:
 * fixed per deployment, shared by all flag variants.
 */
export type ModalityRegistries = Record<
  ModalityField,
  ModalityProvider<unknown>[]
>;

/** Provider by `id`, never MIME: two providers in a field may share a MIME. */
export function findModalityProvider(
  providers: ModalityProvider<unknown>[],
  id: string
): ModalityProvider<unknown> | undefined {
  return providers.find((p) => p.id === id);
}
