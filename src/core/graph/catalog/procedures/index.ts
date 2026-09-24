// Slice surface: catalogue adapters plus the repo. Repo exported because
// `02graphs/03case-translation-from-english/` and `scripts/exportGraphs.ts`
// read translation accessors the `ProcedureCatalog` port doesn't expose.
export { createProceduresRepo, type ProceduresRepo } from "./repo.js";
export { YamlProcedureCatalog, InMemoryProcedureCatalog } from "./catalog.js";
