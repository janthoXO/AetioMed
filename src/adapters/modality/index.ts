import type { ModalityProviderModule } from "./resolve.js";
import { resolveModalityProviders } from "./resolve.js";
import { referralLetterModule } from "./referralLetter/index.js";
import { ecgModule } from "./ecg/index.js";

/** Every pluggable modality provider. A new one is a module here plus its docs row in README-DEV.md. */
export const MODALITY_PROVIDER_MODULES: ModalityProviderModule[] = [
  referralLetterModule,
  ecgModule,
];

export function modalityProvidersFromEnv(env: NodeJS.ProcessEnv) {
  return resolveModalityProviders(MODALITY_PROVIDER_MODULES, env);
}
