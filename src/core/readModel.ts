// Shared read model: REST `GET /api/*` and NATS request/reply call the same
// accessors, so both answer identically. Transports only serialize.
import { z } from "zod";
import type { GraphAppContext } from "./graph/appContext.js";
import { buildGraphStructure, type GraphStructure } from "./graph/structure.js";
import { DiagnosisSchema } from "./graph/shared/domain/Diagnosis.js";
import { LLMConfigSchema } from "./graph/shared/domain/LLMConfig.js";
import { procedureTreeSchema } from "./graph/shared/domain/ProcedureTree.js";

export const DiagnosesSchema = z.array(DiagnosisSchema);
export type Diagnoses = z.infer<typeof DiagnosesSchema>;

/** `null`: freeform, no procedure catalogue configured. */
export const ProcedureCatalogSchema = procedureTreeSchema(
  z.object({ name: z.string() })
).nullable();
export type ProcedureCatalog = z.infer<typeof ProcedureCatalogSchema>;

export const FeaturesSchema = z.array(z.string());

/** Models per provider a request's `llmConfig` may pick; empty unless `ALLOW_LLMS`. */
export const AllowedLlmsSchema = z.partialRecord(
  LLMConfigSchema.shape.provider,
  z.array(z.string())
);
export type AllowedLlms = z.infer<typeof AllowedLlmsSchema>;

export interface ReadModel {
  diagnoses(): Diagnoses;
  procedures(): ProcedureCatalog;
  features(): string[];
  allowedLlms(): AllowedLlms;
  graph(): Promise<GraphStructure>;
}

/** Constructed once in `app.ts`, handed to `startRestServer` and `startNatsTransport`. `features` is the parsed `FEATURES` set. */
export function createReadModel(
  graph: GraphAppContext,
  features: ReadonlySet<string>
): ReadModel {
  return {
    diagnoses() {
      return graph.runtime.catalogs.diagnosis.all();
    },
    procedures() {
      return graph.runtime.catalogs.procedures.tree() ?? null;
    },
    features() {
      return [...features];
    },
    allowedLlms() {
      return graph.config.allowedLlms ?? {};
    },
    graph() {
      return buildGraphStructure(graph.graphs);
    },
  };
}
