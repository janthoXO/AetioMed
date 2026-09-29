import type { EventBus } from "../event-bus.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import { ConfigSchema, type Config } from "./config.js";
import { buildCaseGraph } from "./assemble.js";
import { createMedicalBasisRegistry } from "@/core/graph/02-plan/01-basis/registry.js";
import type { ModalityRegistries } from "@/core/graph/shared/modality/registry.js";
import { createChiefComplaintProviders } from "@/core/graph/04-case/01-presentation/chief-complaint/providers.js";
import { createAnamnesisProviders } from "@/core/graph/04-case/01-presentation/anamnesis/providers.js";
import { createProcedureResultProviders } from "@/core/graph/04-case/02-procedures/providers.js";
import { createLogger } from "./utils/logger.js";
import { LLM_ROLES, type GraphRuntime, type LlmPort } from "./runtime.js";
import type {
  SymptomCache,
  UmlsSymptomFloor,
} from "@/core/graph/02-plan/01-basis/ports.js";
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
 * Build `GraphRuntime` from the adapters `createApp()` constructed, then the
 * graph from it. Called once from `createApp()` before any transport starts.
 */
export function initGraph(opts: {
  bus: EventBus;
  config: Config;
  llm: LlmPort;
  catalogs: GraphRuntime["catalogs"];
  umlsFloor: UmlsSymptomFloor;
  symptomCache: SymptomCache;
  /** OTel port from `observability/otel.ts`'s `createOtelNodeTracer()`. Pass `noopNodeTracer` for silence. */
  tracer: NodeTracer;
}): GraphAppContext {
  const { bus, config, llm, catalogs, umlsFloor, symptomCache, tracer } = opts;

  const runtime: GraphRuntime = {
    llm,
    catalogs,
    log: createLogger(bus),
    clock: () => new Date(),
  };

  // Plain list, not a config flag (see `createMedicalBasisRegistry`). Always
  // `[umlsSymptomProvider]`.
  const medicalBasisRegistry = createMedicalBasisRegistry({
    runtime,
    umlsFloor,
    symptomCache,
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
    medicalBasisRegistry,
    modalityRegistries,
    tracer
  );

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
  };
}

export { runWithContext } from "./utils/context.js";
