import type { ModalityProvider } from "../ports.js";

const TEXT_MIME = "text/plain";

/**
 * The degenerate modality provider (issue 13 §3): `utf8(alt)`, no model call
 * at all, because the text was already produced by `generate_content`. This
 * is what keeps a text-only registry (the only shape that exists today —
 * see `registry.ts`'s `createModalityRegistry`) byte-identical to the old
 * `textPart()` helper (`models/ContentPart.ts`), just reached through the
 * provider abstraction instead of called directly.
 */
export function createTextModalityProvider(): ModalityProvider {
  return {
    id: "text",
    produces: [TEXT_MIME],
    render: (alt) => Promise.resolve(new TextEncoder().encode(alt)),
  };
}
