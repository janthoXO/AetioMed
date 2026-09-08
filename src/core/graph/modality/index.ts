// Public surface of the modality slice.
export type {
  ModalityProvider,
  ModalityRenderRequest,
  RenderContext,
} from "./ports.js";
export { ModalityRenderRequestSchema } from "./ports.js";
export {
  createModalityRegistry,
  findModalityProvider,
  producibleModalities,
  EmptyModalityRegistryError,
} from "./registry.js";
export { createTextModalityProvider } from "./providers/text.js";
export {
  defaultPlanFor,
  renderRequests,
  type ContentUnit,
} from "./pipeline.js";
