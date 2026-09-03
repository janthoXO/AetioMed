// Wiring is deliberately unambitious here: these are module-scope singletons
// constructed eagerly from the YAML-backed repos. Issue 04 replaces this with
// proper dependency injection — do not mistake this for the intended end
// state, and do not try to solve DI as part of this module.
import type { AnamnesisCatalog, ProcedureCatalog } from "./ports.js";
import { YamlProcedureCatalog } from "./procedureCatalog.js";
import { YamlAnamnesisCatalog } from "./anamnesisCatalog.js";

export const procedureCatalog: ProcedureCatalog = new YamlProcedureCatalog();
export const anamnesisCatalog: AnamnesisCatalog = new YamlAnamnesisCatalog();
