// Shared read model: REST `GET /api/*` and NATS request/reply call the same
// accessors, so both answer identically. Transports only serialize.
import type { GraphAppContext } from "./graph/appContext.js";
import { buildGraphStructure, type GraphStructure } from "./graph/structure.js";

export interface ReadModel {
  diagnoses(): unknown;
  procedures(): { name: string }[] | undefined;
  features(): string[];
  allowedLlms(): unknown;
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
      return graph.runtime.catalogs.procedures
        .list()
        ?.map((p) => ({ name: p }));
    },
    features() {
      return [...features];
    },
    allowedLlms() {
      return graph.config.allowedLlms || [];
    },
    graph() {
      return buildGraphStructure(graph.graphs);
    },
  };
}
