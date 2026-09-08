// Public surface of the medical-basis slice.
export type {
  MedicalBasisProvider,
  BasisQuery,
  BasisFragment,
} from "./ports.js";
export { BasisQuerySchema, BasisFragmentSchema } from "./ports.js";
export {
  renderMedicalBasisSection,
  BASIS_FRAGMENT_OPEN,
  BASIS_FRAGMENT_CLOSE,
} from "./render.js";
export { createMedicalBasisRegistry, resolveAllFragments } from "./registry.js";
export { createUmlsSymptomProvider } from "./providers/umlsSymptoms.js";
