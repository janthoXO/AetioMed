// Public surface of the diagnosis slice: the catalogue port adapters plus
// the repo itself (exported so the composition root, `repos.ts`, can
// construct it). Unlike procedures/anamnesis, no module outside this
// slice's own catalog adapter reaches into the repo for anything the
// `DiagnosisCatalog` port doesn't already expose.
export { createDiagnosisRepo, type DiagnosisRepo } from "./repo.js";
export { YamlDiagnosisCatalog, InMemoryDiagnosisCatalog } from "./catalog.js";
