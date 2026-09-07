// Public surface of the modality slice.
export type {
  ModalityProvider,
  ModalityPlan,
  PlannedPart,
  RenderContext,
} from "./ports.js";
export { PlannedPartSchema, defineModalityProvider } from "./ports.js";
export {
  findModalityProvider,
  EmptyModalityRegistryError,
  type ModalityField,
  type ModalityRegistries,
} from "./registry.js";
export { describeProviders, buildCompositionSchema } from "./composition.js";
export { renderPlan } from "./pipeline.js";
