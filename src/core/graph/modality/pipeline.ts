import type { ContentPart } from "@/core/graph/models/ContentPart.js";
import type { Logger } from "@/core/graph/runtime.js";
import { findModalityProvider } from "./registry.js";
import type {
  ModalityPlan,
  ModalityProvider,
  PlannedPart,
  RenderContext,
} from "./ports.js";

/** One planned request's position in the final, per-unit part arrays. */
type Slot = { unitKey: string; index: number; request: PlannedPart };

/**
 * Renders an entire field's plan: flattens every unit's planned requests,
 * groups them by provider id ACROSS units (so, e.g., one anamnesis text call
 * covers every category's instruction, and one image call covers every
 * image in the field), calls each provider's `render` exactly once with its
 * whole batch, then scatters the results back into `(unitKey, slot)` order
 * — PLANNED order, never completion order (same rule and reason as
 * `medicalBasis/registry.ts`'s `resolveAllFragments`: otherwise the same
 * plan would produce different field content run to run, which makes
 * evaluation meaningless).
 *
 * `renderPlan` is the ONLY place a `ContentPart` is constructed.
 *
 * Failure policy: a provider that throws (or an id the plan names but the
 * registry does not carry) is logged and its parts are dropped — one bad
 * provider must not fail the whole field. A unit left with zero parts after
 * that throws: `ContentPartsSchema.min(1)` would reject it downstream
 * anyway, and a silently empty field is worse than a loud error.
 *
 * `runtime.log` is not reachable here (this module sits below `GraphRuntime`),
 * mirroring `medicalBasis/registry.ts`'s `resolveAllFragments` — the caller
 * passes its own `Logger` instead.
 */
export async function renderPlan(
  providers: ModalityProvider<unknown>[],
  plan: ModalityPlan,
  ctx: RenderContext | undefined,
  log: Logger
): Promise<Record<string, ContentPart[]>> {
  const slots: Slot[] = [];
  for (const [unitKey, requests] of Object.entries(plan)) {
    requests.forEach((request, index) =>
      slots.push({ unitKey, index, request })
    );
  }

  const byProvider = new Map<string, Slot[]>();
  for (const slot of slots) {
    const forProvider = byProvider.get(slot.request.provider);
    if (forProvider) forProvider.push(slot);
    else byProvider.set(slot.request.provider, [slot]);
  }

  // Pre-sized per unit so a provider failure leaves a sparse (not
  // shrunk-and-reindexed) array — planned order survives a partial failure.
  const rendered = new Map<string, (ContentPart | undefined)[]>(
    Object.entries(plan).map(([unitKey, requests]) => [
      unitKey,
      new Array<ContentPart | undefined>(requests.length),
    ])
  );

  await Promise.all(
    [...byProvider.entries()].map(async ([providerId, providerSlots]) => {
      const provider = findModalityProvider(providers, providerId);
      if (!provider) {
        log.error(
          `[modality] No provider registered for id "${providerId}" — dropping ${providerSlots.length} planned part(s).`
        );
        return;
      }
      try {
        const buffers = await provider.render(
          providerSlots.map((slot) => slot.request.input),
          ctx ?? {}
        );
        providerSlots.forEach((slot, i) => {
          rendered.get(slot.unitKey)![slot.index] = {
            type: provider.mime,
            value: buffers[i]!,
            alt: slot.request.alt,
          };
        });
      } catch (error) {
        log.error(
          `[modality] provider "${providerId}" failed and its ${providerSlots.length} planned part(s) were dropped: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })
  );

  const result: Record<string, ContentPart[]> = {};
  for (const [unitKey, parts] of rendered) {
    const defined = parts.filter((p): p is ContentPart => p !== undefined);
    if (defined.length === 0) {
      throw new Error(
        `Modality rendering produced zero parts for content unit "${unitKey}" — every planned provider for it failed or was unregistered.`
      );
    }
    result[unitKey] = defined;
  }
  return result;
}
