// Public surface of the anamnesis slice: the catalogue port adapters plus
// the repo itself. The repo is exported (not just the catalog) because
// `02graphs/03case-translation-from-english/` (`index.ts` and `tools.ts`)
// bypasses the `AnamnesisCatalog` port to reach
// `getAnamnesisCategoryTranslationFromEnglish` /
// `saveAnamnesisCategoryTranslations` directly — translation accessors the
// port does not expose. Issue #89 collapses this to a single entry point.
export { createAnamnesisRepo, type AnamnesisRepo } from "./repo.js";
export { YamlAnamnesisCatalog, InMemoryAnamnesisCatalog } from "./catalog.js";
