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
 * Renders a field's plan: flattens unit requests, groups by provider id
 * ACROSS units, one `render` call per provider with its whole batch, scatters
 * results back in PLANNED order, never completion order.
 *
 * ONLY place a `ContentPart` is constructed.
 *
 * Provider throws or unknown id: logged, parts dropped. Unit left with zero
 * parts throws (empty field is invalid). Caller passes its own `Logger`;
 * `GraphRuntime` not reachable here.
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

  // Pre-sized per unit: failure leaves sparse array, planned order survives.
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
