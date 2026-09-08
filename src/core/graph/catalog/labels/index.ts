// Public surface of the labels slice: the catalogue port adapters plus the
// repo itself (exported so the composition root, `repos.ts`, can construct
// it). Unlike procedures/anamnesis, no module outside this slice's own
// catalog adapter reaches into the repo for anything the `LabelCatalog` port
// doesn't already expose.
export { createLabelsRepo, type LabelsRepo } from "./repo.js";
export { YamlLabelCatalog, InMemoryLabelCatalog } from "./catalog.js";
