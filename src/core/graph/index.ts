import type { EventBus } from "../event-bus.js";
import type { Case } from "./models/Case.js";
import { ConfigSchema, type Config } from "./config.js";
import { validateCatalogsOrExit } from "./catalog/startupValidation.js";
import { buildCaseGraph } from "./02graphs/caseGraph.js";
import { createYamlCatalogs } from "./catalog/index.js";
import { createRepos } from "./repos.js";
import { createMedicalBasisRegistry } from "./medicalBasis/registry.js";
import { createModalityRegistry } from "./modality/registry.js";
import { createLlmPort } from "./utils/llm.js";
import { createLogger } from "./utils/logger.js";
import { LLM_ROLES, type GraphRuntime } from "./runtime.js";
import type { GraphAppContext } from "./appContext.js";

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
      timestamp: string;
    };
    "Node Completed": {
      node: string;
      label?: string;
      result: unknown;
      jobId?: string;
      timestamp: string;
    };
  }
}

export { ConfigSchema };

/**
 * Build the `GraphRuntime` (ports), construct the graph as a function of it,
 * and validate the catalogues. Called once from `createApp()`, before any
 * transport starts — there is no module-scope mutable state left for
 * transports to race against.
 */
export function initGraph(opts: {
  bus: EventBus;
  config: Config;
  /** Already-resolved absolute path (see `persistence/paths.ts`). */
  catalogDir: string;
  /** Already-resolved absolute path (see `persistence/paths.ts`). */
  cacheDir: string;
  symptomCacheTtlDays: number;
}): GraphAppContext {
  const { bus, config, catalogDir, cacheDir, symptomCacheTtlDays } = opts;

  const repos = createRepos({ catalogDir, cacheDir, symptomCacheTtlDays });

  const runtime: GraphRuntime = {
    llm: createLlmPort(config),
    catalogs: createYamlCatalogs(repos),
    log: createLogger(bus),
    clock: () => new Date(),
  };

  // The medical-basis registry is a plain list built here, in the
  // composition root — not a `FEATURES`/config flag (see
  // `medicalBasis/registry.ts`'s `createMedicalBasisRegistry` doc comment
  // for why). Today it always returns `[umlsSymptomProvider]`; a deployer
  // cannot currently switch it off.
  const medicalBasisRegistry = createMedicalBasisRegistry({
    runtime,
    symptomsRepo: repos.symptoms,
  });

  // The modality registry is likewise a plain list built here, not a
  // `FEATURES`/config flag — see `modality/registry.ts`'s
  // `createModalityRegistry` doc comment. Today it always returns
  // `[textProvider]`, which is why `chiefComplaintGraph`/`anamnesisGraph`
  // (`02presentation/generation/`) never compile in a `decide_modality`
  // node in this deployment.
  const modalityRegistry = createModalityRegistry();

  const { generateCase } = buildCaseGraph(
    runtime,
    bus,
    config,
    repos,
    medicalBasisRegistry,
    modalityRegistry
  );

  // Validate catalogue translation files here, and not any earlier: the
  // "labels" catalogue's base key set is `getKnownLabels()`
  // (utils/nodeWrapper.ts), which `traceNode` populates as `buildCaseGraph`
  // constructs the graph modules above. Running the validation any earlier
  // would validate labels against an empty set and silently pass.
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

  return { config, runtime, generateCase };
}

export { runWithContext, registerJobHook } from "./utils/context.js";
export * as cancelManager from "./utils/cancelManager.js";
