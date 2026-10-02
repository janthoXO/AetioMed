// Slice surface: catalogue adapters plus the repo (exported for `repos.ts`).
// Nothing outside the slice's catalog adapter reaches past the `DiagnosisCatalog` port.
export { createDiagnosisRepo, type DiagnosisRepo } from "./repo.js";
export { YamlDiagnosisCatalog, InMemoryDiagnosisCatalog } from "./catalog.js";
