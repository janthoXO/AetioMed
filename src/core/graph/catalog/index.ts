// Composition helper: builds the full `GraphRuntime["catalogs"]` bundle from
// the YAML-backed repos. Callers needing a single catalogue in isolation
// (tests, InMemory adapters) should import the adapter classes directly
// rather than going through this bundle.
import type { GraphRuntime } from "../runtime.js";
import { YamlProcedureCatalog } from "./procedureCatalog.js";
import { YamlAnamnesisCatalog } from "./anamnesisCatalog.js";
import { YamlLabelCatalog } from "./labelCatalog.js";
import { YamlDiagnosisCatalog } from "./diagnosisCatalog.js";

export function createYamlCatalogs(): GraphRuntime["catalogs"] {
  return {
    procedures: new YamlProcedureCatalog(),
    anamnesis: new YamlAnamnesisCatalog(),
    labels: new YamlLabelCatalog(),
    diagnosis: new YamlDiagnosisCatalog(),
  };
}

export type {
  ProcedureCatalog,
  AnamnesisCatalog,
  LabelCatalog,
  DiagnosisCatalog,
} from "./ports.js";
