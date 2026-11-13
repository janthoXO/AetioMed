import type { EventBus } from "../event-bus.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import { ConfigSchema, type Config } from "./config.js";
import { buildCaseGraph } from "./assemble.js";
import { createMedicalBasisRegistry } from "@/core/graph/02-plan/01-basis/registry.js";
import type {
  ModalityField,
  ModalityRegistries,
} from "@/core/graph/shared/modality/registry.js";
import type { ModalityProvider } from "@/core/graph/shared/modality/ports.js";
import { allowedProviders } from "@/core/graph/shared/modality/composition.js";
import { leaves, refLabel } from "@/core/graph/shared/domain/ProcedureTree.js";
import { createChiefComplaintProviders } from "@/core/graph/04-case/01-presentation/chief-complaint/providers.js";
import { createAnamnesisProviders } from "@/core/graph/04-case/01-presentation/anamnesis/providers.js";
import { createProcedureResultProviders } from "@/core/graph/04-case/02-procedures/providers.js";
import { createLogger } from "./utils/logger.js";
import { LLM_ROLES, type GraphRuntime, type LlmPort } from "./runtime.js";
import type {
  SymptomCache,
  SymptomMapping,
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
  /** ICD client configured (`adapters/icd/`); resolution itself runs in the service. */
  icd: boolean;
  llm: LlmPort;
  catalogs: GraphRuntime["catalogs"];
  symptomMapping: SymptomMapping;
  symptomCache: SymptomCache;
  /** OTel port from `observability/otel.ts`'s `createOtelNodeTracer()`. Pass `noopNodeTracer` for silence. */
  tracer: NodeTracer;
  /** Pluggable providers per field (`adapters/modality/`, resolved from `MODALITY_PROVIDERS`), added after each field's own. */
  modalityProviders?: (runtime: GraphRuntime) => Partial<ModalityRegistries>;
}): GraphAppContext {
  const { bus, config, llm, catalogs, symptomMapping, symptomCache, tracer } =
    opts;

  const runtime: GraphRuntime = {
    llm,
    catalogs,
    log: createLogger(bus),
    clock: () => new Date(),
  };

  // Plain list, not a config flag (see `createMedicalBasisRegistry`). Always
  // `[mappedSymptomProvider]`.
  const medicalBasisRegistry = createMedicalBasisRegistry({
    runtime,
    symptomMapping,
    symptomCache,
  });

  // Per-field modality registries: the field's own always-on providers (its
  // `providers.ts` slice), then the pluggable ones enabled for it.
  const extra = opts.modalityProviders?.(runtime) ?? {};
  const modalityRegistries: ModalityRegistries = {
    chiefComplaint: [
      ...createChiefComplaintProviders(runtime),
      ...(extra.chiefComplaint ?? []),
    ],
    anamnesis: [
      ...createAnamnesisProviders(runtime),
      ...(extra.anamnesis ?? []),
    ],
    procedureResult: [
      ...createProcedureResultProviders(runtime),
      ...(extra.procedureResult ?? []),
    ],
  };
  for (const [field, providers] of Object.entries(modalityRegistries)) {
    const ids = providers.map((p) => p.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup)
      throw new Error(`[modality] ${field}: duplicate provider id "${dup}"`);
  }
  const procedureTree = catalogs.procedures.tree();
  checkProviderAllowlists(
    "procedureResult",
    modalityRegistries.procedureResult,
    procedureTree
      ? leaves(procedureTree).map(({ path, leaf }) => ({
          name: refLabel({ path, name: leaf.name }),
          providers: leaf.providers,
        }))
      : undefined
  );
  checkProviderAllowlists(
    "anamnesis",
    modalityRegistries.anamnesis,
    catalogs.anamnesis.list()?.map((name) => ({
      name,
      providers: catalogs.anamnesis.providers(name),
    }))
  );

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
    icd: opts.icd,
    runtime,
    planCase,
    renderCase,
    translateOutline,
    graphs,
  };
}

export { runWithContext } from "./utils/context.js";

/**
 * Startup view of a field's provider allow-lists (`allowedProviders`): logs
 * how many catalogue units each provider serves, warns about a named id not
 * registered in the field, throws when a unit is left with no provider.
 * `units` undefined = freeform, nothing to check.
 */
export function checkProviderAllowlists(
  field: ModalityField,
  providers: ModalityProvider<unknown>[],
  units: { name: string; providers?: string[] | undefined }[] | undefined
): void {
  if (!units?.length) return;
  const named = new Set(units.flatMap((u) => u.providers ?? []));
  const ids = new Set(providers.map((p) => p.id));
  const unknown = [...named].filter((id) => !ids.has(id));
  if (unknown.length > 0)
    console.warn(
      `[modality] ${field}: catalogue names provider(s) ${unknown.join(", ")} not enabled for this field — ignored`
    );
  const allowed = units.map((u) =>
    allowedProviders(providers, named, u.providers).map((p) => p.id)
  );
  const empty = units.filter((_, i) => allowed[i]!.length === 0);
  if (empty.length > 0)
    throw new Error(
      `[modality] ${field}: no enabled provider allowed for ${empty.map((u) => `"${u.name}"`).join(", ")}`
    );
  console.log(
    `[modality] ${field}: ${providers
      .map(
        (p) =>
          `${p.id} ${allowed.filter((a) => a.includes(p.id)).length}/${units.length}`
      )
      .join(", ")}`
  );
}
