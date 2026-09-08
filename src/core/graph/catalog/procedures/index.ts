// Public surface of the procedures slice: the catalogue port adapters plus
// the repo itself. The repo is exported (not just the catalog) because
// `02graphs/03case-translation-from-english/` (`index.ts` and `tools.ts`)
// and `02graphs/exportGraphs.ts` bypass the `ProcedureCatalog` port to reach
// `getProcedureNameTranslationFromEnglish` / `saveProcedureNameTranslation`
// directly — translation accessors the port does not expose. Issue #89
// collapses this to a single entry point.
export { createProceduresRepo, type ProceduresRepo } from "./repo.js";
export { YamlProcedureCatalog, InMemoryProcedureCatalog } from "./catalog.js";
