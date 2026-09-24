// Builds the `GraphRuntime["catalogs"]` bundle from a `Repos` bundle. Tests
// needing one catalogue import its adapter directly.
import type { GraphRuntime } from "../runtime.js";
import type { Repos } from "../repos.js";
import { YamlProcedureCatalog } from "./procedures/index.js";
import { YamlAnamnesisCatalog } from "./anamnesis/index.js";
import { YamlLabelCatalog } from "./labels/index.js";
import { YamlDiagnosisCatalog } from "./diagnosis/index.js";

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
