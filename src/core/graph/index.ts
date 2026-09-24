import type { EventBus } from "../event-bus.js";
import type { Case } from "./models/Case.js";
import type { Language } from "./models/Language.js";
import { ConfigSchema, type Config } from "./config.js";
import { validateCatalogsOrExit } from "./catalog/startupValidation.js";
import { buildCaseGraph } from "./02graphs/caseGraph.js";
import { createYamlCatalogs } from "./catalog/index.js";
import { createRepos } from "./repos.js";
import { createMedicalBasisRegistry } from "./medicalBasis/registry.js";
import type { ModalityRegistries } from "./modality/registry.js";
import { createChiefComplaintProviders } from "./02graphs/02case-generation/02presentation/generation/chiefComplaint/providers.js";
import { createAnamnesisProviders } from "./02graphs/02case-generation/02presentation/generation/anamnesis/providers.js";
import { createProcedureResultProviders } from "./02graphs/02case-generation/03procedure/providers.js";
import { createLlmPort } from "./utils/llm.js";
import { createLogger } from "./utils/logger.js";
import { LLM_ROLES, type GraphRuntime } from "./runtime.js";
import type { GraphAppContext } from "./appContext.js";
import type { NodeTracer } from "./utils/nodeWrapper.js";

declare module "../event-bus.js" {
  interface EventMap {
    "Generation Completed": {
      case: Case;
      jobId?: string;
      additionalData?: object;
    };
    "Generation Failure": {
      error: Error;
      jobId?: string;
      additionalData?: object;
    };
    "Generation Cancelled": {
      jobId?: string;
    };
    "Generation Log": {
      msg: string;
      logLevel: "info" | "warn" | "error";
      timestamp: string;
      additionalData?: object;
    };
    "Node Started": {
      node: string;
      label?: string;
      jobId?: string;
      language?: Language;
      timestamp: string;
    };
    "Node Completed": {
      node: string;
      label?: string;
      result: unknown;
      jobId?: string;
      language?: Language;
      timestamp: string;
    };
    "Node Failed": {
      node: string;
      label?: string;
      error: string;
      jobId?: string;
      language?: Language;
      timestamp: string;
    };
  }
}

export { ConfigSchema };

/**
 * Build `GraphRuntime`, construct graph from it, validate catalogues. Called
 * once from `createApp()` before any transport starts.
 */
export function initGraph(opts: {
  bus: EventBus;
  config: Config;
  /** Already-resolved absolute path (see `persistence/paths.ts`). */
  catalogDir: string;
  /** Already-resolved absolute path (see `persistence/paths.ts`). */
  cacheDir: string;
  symptomCacheTtlDays: number;
  /** OTel port from `observability/otel.ts`'s `createOtelNodeTracer()`. Pass `noopNodeTracer` for silence. */
  tracer: NodeTracer;
}): GraphAppContext {
  const { bus, config, catalogDir, cacheDir, symptomCacheTtlDays, tracer } =
    opts;

  const repos = createRepos({ catalogDir, cacheDir, symptomCacheTtlDays });

  const runtime: GraphRuntime = {
    llm: createLlmPort(config),
    catalogs: createYamlCatalogs(repos),
    log: createLogger(bus),
    clock: () => new Date(),
  };

  // Plain list, not a config flag (see `createMedicalBasisRegistry`). Always
  // `[umlsSymptomProvider]`.
  const medicalBasisRegistry = createMedicalBasisRegistry({
    runtime,
    symptomsRepo: repos.symptoms,
  });

  // Per-field modality registries; each field's providers come from its own
  // `providers.ts` slice.
  const modalityRegistries: ModalityRegistries = {
    chiefComplaint: createChiefComplaintProviders(runtime),
    anamnesis: createAnamnesisProviders(runtime),
    procedureResult: createProcedureResultProviders(runtime),
  };

  const { graphs, planCase, renderCase, translateOutline } = buildCaseGraph(
    runtime,
    bus,
    config,
    repos,
    medicalBasisRegistry,
    modalityRegistries,
    tracer
  );

  // Must run after graph construction: labels' base key set is
  // `getKnownLabels()`, populated by `traceNode` while graph builds. Earlier =
  // empty set, silent pass.
  validateCatalogsOrExit(repos, config.LANGUAGES);

  if (config.allowedLlms) {
    console.log("[graph] Initialized with dynamic LLMs configuration.");
  } else {
    console.log(
      "[graph] LLM roles (temperature is per call site, not configurable):"
    );
    for (const role of LLM_ROLES) {
      const roleConfig = config.llmRoles?.[role];
      console.log(
        `[graph]   ${role.padEnd(10)} ${roleConfig?.provider ?? "?"}/${roleConfig?.model ?? "?"}`
      );
    }
  }

  return {
    config,
    runtime,
    planCase,
    renderCase,
    translateOutline,
    graphs,
    db: repos.db,
  };
}

export { runWithContext } from "./utils/context.js";
