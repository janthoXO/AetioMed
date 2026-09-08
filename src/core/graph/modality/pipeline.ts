import type { ContentPart } from "@/core/graph/models/ContentPart.js";
import { findModalityProvider } from "./registry.js";
import type {
  ModalityProvider,
  ModalityRenderRequest,
  RenderContext,
} from "./ports.js";

/**
 * One field's (or, for anamnesis, one category's) canonical text — what
 * `generate_content` produced, before any rendering decision. See
 * `02presentation/generation/pipeline.ts` for how this is derived from the
 * existing gateway calls without touching their prompts.
 */
export type ContentUnit = { key: string; text: string };

/**
 * The single-entry-registry default plan (§4: "That provider runs directly.
 * No decide node is compiled in."): one render request per unit, in the
 * registry's only producible MIME, with `alt` set to the unit's whole
 * canonical text. This is what keeps a text-only registry byte-identical to
 * the old `textPart()`-based generators — the sole provider is the text
 * provider, so this reproduces `textPart(text)` exactly, just reached
 * through the provider abstraction.
 */
export function defaultPlanFor(
  units: ContentUnit[],
  providers: ModalityProvider[]
): Record<string, ModalityRenderRequest[]> {
  const provider = providers[0];
  if (!provider) {
    // Unreachable in practice: callers only take this path after confirming
    // `providers.length === 1` (see `buildContentPartsSubgraph`).
    throw new Error("defaultPlanFor called with an empty provider list");
  }
  const modality = provider.produces[0];
  if (!modality) {
    throw new Error(
      `Modality provider "${provider.id}" declares no producible MIME types.`
    );
  }
  return Object.fromEntries(
    units.map((unit) => [unit.key, [{ modality, alt: unit.text }]])
  );
}

/**
 * Renders one unit's ordered render requests into `ContentPart[]`,
 * preserving the order the requests were PLANNED in, not completion order —
 * same shape and same reason as `medicalBasis/registry.ts`'s
 * `resolveAllFragments`: `Promise.all` preserves input order regardless of
 * resolution order, so running every request concurrently and returning the
 * results in that order is what gives deterministic, planned-order fan-in
 * (issue 13 §5). Test with staggered fake providers where the first-planned
 * request resolves last.
 */
export async function renderRequests(
  providers: ModalityProvider[],
  requests: ModalityRenderRequest[],
  context: RenderContext | undefined
): Promise<ContentPart[]> {
  return Promise.all(
    requests.map(async (request): Promise<ContentPart> => {
      const provider = findModalityProvider(providers, request.modality);
      if (!provider) {
        throw new Error(
          `No modality provider registered for "${request.modality}".`
        );
      }
      const value = await provider.render(request.alt, context ?? {});
      return { type: request.modality, value, alt: request.alt };
    })
  );
}
