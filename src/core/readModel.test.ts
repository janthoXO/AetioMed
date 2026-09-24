// Each accessor against fake `GraphAppContext`: delegates, no reimplementation.
// REST-vs-NATS parity tested in `src/transports/nats/nats.parity.integration.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { createReadModel } from "./readModel.js";
import type { GraphAppContext } from "./graph/appContext.js";
import type { GraphStructure } from "./graph/structure.js";
import { planAndRenderFrom } from "@/testing/graphFakes.js";

function fakeGraph(): GraphAppContext {
  return {
    config: {
      allowedLlms: ["ollama:llama3.1"],
    } as GraphAppContext["config"],
    runtime: {
      catalogs: {
        diagnosis: { all: () => [{ icd: "1A00", name: "Cholera" }] },
        procedures: { list: () => ["Chest X-ray", "CBC"] },
      },
    } as unknown as GraphAppContext["runtime"],
    ...planAndRenderFrom(vi.fn()),
    graphs: {
      plan: {
        getGraphAsync: async () => ({
          nodes: { __start__: {}, __end__: {} },
          edges: [{ source: "__start__", target: "__end__" }],
        }),
      },
      case: {
        getGraphAsync: async () => ({
          nodes: { __start__: {}, a: {}, __end__: {} },
          edges: [
            { source: "__start__", target: "a" },
            { source: "a", target: "__end__" },
          ],
        }),
      },
    } as unknown as GraphAppContext["graphs"],
  } as GraphAppContext;
}

describe("createReadModel", () => {
  it("diagnoses() delegates to the diagnosis catalog", () => {
    const readModel = createReadModel(fakeGraph(), new Set());
    expect(readModel.diagnoses()).toEqual([{ icd: "1A00", name: "Cholera" }]);
  });

  it("procedures() maps the procedure catalog's list to {name} objects", () => {
    const readModel = createReadModel(fakeGraph(), new Set());
    expect(readModel.procedures()).toEqual([
      { name: "Chest X-ray" },
      { name: "CBC" },
    ]);
  });

  it("procedures() passes through undefined when the catalog has no predefined list", () => {
    const graph = fakeGraph();
    (graph.runtime.catalogs.procedures as { list: () => undefined }).list =
      () => undefined;
    const readModel = createReadModel(graph, new Set());
    expect(readModel.procedures()).toBeUndefined();
  });

  it("features() reflects the feature set passed in", () => {
    const readModel = createReadModel(fakeGraph(), new Set(["REST", "NATS"]));
    expect(readModel.features()).toEqual(["REST", "NATS"]);
  });

  it("allowedLlms() delegates to config.allowedLlms", () => {
    const readModel = createReadModel(fakeGraph(), new Set());
    expect(readModel.allowedLlms()).toEqual(["ollama:llama3.1"]);
  });

  it("allowedLlms() falls back to [] when unset", () => {
    const graph = fakeGraph();
    (graph.config as { allowedLlms?: unknown }).allowedLlms = undefined;
    const readModel = createReadModel(graph, new Set());
    expect(readModel.allowedLlms()).toEqual([]);
  });

  it("graph() delegates to buildGraphStructure, filtering synthetic nodes", async () => {
    const readModel = createReadModel(fakeGraph(), new Set());
    const structure: GraphStructure = await readModel.graph();
    expect(structure.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(structure.edges).toEqual([]);
  });
});
