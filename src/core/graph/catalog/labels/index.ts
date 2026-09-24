// Slice surface: catalogue adapters plus the repo (exported for `repos.ts`).
// Nothing outside the slice's catalog adapter reaches past the `LabelCatalog` port.
export { createLabelsRepo, type LabelsRepo } from "./repo.js";
export { YamlLabelCatalog, InMemoryLabelCatalog } from "./catalog.js";
