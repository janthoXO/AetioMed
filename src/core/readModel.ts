// Shared read model (#144). Both transports' read-only endpoints — REST's
// `GET /api/*` and NATS's request/reply group — must answer with the same
// payload for the same question, and the way to make that true "by
// construction" rather than "by remembering to keep two copies in sync" is
// to have both call the same function. `src/transports/rest/routes/*` and
// `src/transports/nats/metaService.ts` are protocol translation only: they
// call one of these accessors and serialize the result onto their own wire.
import type { GraphAppContext } from "./graph/appContext.js";
import { buildGraphStructure, type GraphStructure } from "./graph/structure.js";

export interface ReadModel {
  diagnoses(): unknown;
  procedures(): { name: string }[] | undefined;
  features(): string[];
  allowedLlms(): unknown;
  graph(): Promise<GraphStructure>;
}

/**
 * Construct once in `app.ts` and hand to both `startRestServer` (via
 * `createRestApp`'s `readModel` option) and `startNatsTransport`. `features`
 * is the same flag set the composition root already parsed from `FEATURES`.
 */
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
