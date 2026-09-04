import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { decideModalityComposition } from "./modalityDecision.aigateway.js";
import { InMemoryProcedureCatalog } from "@/core/graph/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/core/graph/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/core/graph/catalog/diagnosis/index.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

function buildRuntime(response: string): GraphRuntime {
  return {
    llm: { for: () => new FakeListChatModel({ responses: [response] }) },
    catalogs: {
      procedures: new InMemoryProcedureCatalog(),
      anamnesis: new InMemoryAnamnesisCatalog(),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };
}

describe("decideModalityComposition", () => {
  it("maps the LLM's plan into a Record keyed by unit, preserving request order per key", async () => {
    const runtime = buildRuntime(
      JSON.stringify({
        plans: [
          {
            key: "chiefComplaint",
            requests: [
              { modality: "text/plain", alt: "the full text" },
              { modality: "image/png", alt: "a picture of the complaint" },
            ],
          },
        ],
      })
    );

    const plan = await decideModalityComposition(
      runtime,
      [{ key: "chiefComplaint", text: "Acute dyspnea." }],
      ["text/plain", "image/png"]
    );

    expect(plan).toEqual({
      chiefComplaint: [
        { modality: "text/plain", alt: "the full text" },
        { modality: "image/png", alt: "a picture of the complaint" },
      ],
    });
  });

  it("plans independently for every unit passed in (e.g. one per anamnesis category)", async () => {
    const runtime = buildRuntime(
      JSON.stringify({
        plans: [
          {
            key: "Current Symptoms",
            requests: [{ modality: "text/plain", alt: "fever" }],
          },
          {
            key: "Past Illnesses",
            requests: [{ modality: "text/plain", alt: "none" }],
          },
        ],
      })
    );

    const plan = await decideModalityComposition(
      runtime,
      [
        { key: "Current Symptoms", text: "Fever." },
        { key: "Past Illnesses", text: "None." },
      ],
      ["text/plain"]
    );

    expect(Object.keys(plan)).toEqual(["Current Symptoms", "Past Illnesses"]);
  });
});
