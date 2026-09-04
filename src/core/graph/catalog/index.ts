// Composition helper: builds the full `GraphRuntime["catalogs"]` bundle from
// a constructed `Repos` bundle (see `03repo/index.ts`). Callers needing a
// single catalogue in isolation (tests, InMemory adapters) should import the
// adapter classes directly rather than going through this bundle.
import type { GraphRuntime } from "../runtime.js";
import type { Repos } from "../03repo/index.js";
import { YamlProcedureCatalog } from "./procedureCatalog.js";
import { YamlAnamnesisCatalog } from "./anamnesisCatalog.js";
import { YamlLabelCatalog } from "./labelCatalog.js";
import { YamlDiagnosisCatalog } from "./diagnosisCatalog.js";

export function createYamlCatalogs(repos: Repos): GraphRuntime["catalogs"] {
  return {
    procedures: new YamlProcedureCatalog(repos.procedures),
    anamnesis: new YamlAnamnesisCatalog(repos.anamnesis),
    labels: new YamlLabelCatalog(repos.labels),
    diagnosis: new YamlDiagnosisCatalog(repos.diagnosis),
  };
}

export type {
  ProcedureCatalog,
  AnamnesisCatalog,
  LabelCatalog,
  DiagnosisCatalog,
} from "./ports.js";
