// Slice surface: catalogue adapters plus the repo. Repo exported because
// `02graphs/03case-translation-from-english/` reads translation accessors the
// `AnamnesisCatalog` port doesn't expose.
export { createAnamnesisRepo, type AnamnesisRepo } from "./repo.js";
export { YamlAnamnesisCatalog, InMemoryAnamnesisCatalog } from "./catalog.js";
