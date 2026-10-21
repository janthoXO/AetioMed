// `CatalogPick.nextStep`: a flat label pick (at least one), diagnose only after the first batch.
import { chatModelLlmPort } from "@/adapters/ai/llm.js";
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { BaseMessage } from "@langchain/core/messages";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/adapters/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/adapters/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/adapters/catalog/labels/index.js";
import { InMemoryOutlineHeadingCatalog } from "@/adapters/catalog/outlineHeadings/index.js";
import { InMemoryDiagnosisCatalog } from "@/adapters/catalog/diagnosis/index.js";
import { CatalogPick } from "./catalogPick.js";

/** Records every call's messages; replies from `responses` in order. */
class CapturingChatModel extends FakeListChatModel {
  calls: BaseMessage[][] = [];
  override async _generate(
    ...args: Parameters<FakeListChatModel["_generate"]>
  ) {
    this.calls.push(args[0]);
    return super._generate(...args);
  }
}

describe("CatalogPick.nextStep", () => {
  function pickWith(model: CapturingChatModel) {
    const runtime: GraphRuntime = {
      llm: chatModelLlmPort(() => model),
      catalogs: {
        procedures: new InMemoryProcedureCatalog({
          procedures: [{ name: "Vitals" }, { name: "HbA1c" }],
          categories: [],
        }),
        anamnesis: new InMemoryAnamnesisCatalog(),
        labels: new InMemoryLabelCatalog(),
        outlineHeadings: new InMemoryOutlineHeadingCatalog(),
        diagnosis: new InMemoryDiagnosisCatalog(),
      },
      log: { info() {}, warn() {}, error() {} },
      clock: () => new Date("2024-01-01T00:00:00.000Z"),
    };
    return new CatalogPick(runtime, []);
  }

  const view = {
    presentation: { chiefComplaint: "Polyuria and polydipsia" },
    ruledOutDiagnoses: [],
    iterationsRemaining: 6,
  };

  it("does not offer a diagnosis before the first batch, so a workup always has procedures", async () => {
    const model = new CapturingChatModel({
      responses: [
        JSON.stringify({
          action: "procedure",
          procedures: ["HbA1c"],
        }),
      ],
    });
    const move = await pickWith(model).nextStep({
      ...view,
      previousProcedures: [],
    });
    expect(move).toMatchObject({
      action: "order",
      procedures: [{ path: [], name: "HbA1c" }],
    });
    expect(
      model.calls[0]!.map((m) => String(m.content)).join("\n")
    ).not.toContain('"diagnose"');
  });

  it("retries an empty pick instead of returning nothing", async () => {
    const order = (procedures: string[]) =>
      JSON.stringify({ action: "procedure", procedures });
    const model = new CapturingChatModel({
      responses: [order([]), order(["Vitals"])],
    });
    const move = await pickWith(model).nextStep({
      ...view,
      previousProcedures: [],
    });
    expect(model.calls).toHaveLength(2);
    expect(move).toMatchObject({
      action: "order",
      procedures: [{ path: [], name: "Vitals" }],
    });
  });

  it("offers a diagnosis once something has been ordered", async () => {
    const model = new CapturingChatModel({
      responses: [
        JSON.stringify({
          action: "diagnose",
          diagnosisName: "Diabetes",
          supportingResult: "HbA1c",
        }),
      ],
    });
    const move = await pickWith(model).nextStep({
      ...view,
      previousProcedures: [
        {
          path: [],
          name: "HbA1c",
          relevance: "obligatory",
          result: "HbA1c 8.1 %",
        },
      ],
    });
    expect(move).toMatchObject({
      action: "diagnose",
      diagnosisName: "Diabetes",
      supportingResult: "HbA1c",
    });
  });

  it("rejects a commit whose supporting result was never ordered", async () => {
    const commit = (supportingResult: string) =>
      JSON.stringify({
        action: "diagnose",
        diagnosisName: "Diabetes",
        supportingResult,
      });
    const model = new CapturingChatModel({
      responses: [commit("Fasting glucose"), commit("HbA1c")],
    });
    const move = await pickWith(model).nextStep({
      ...view,
      previousProcedures: [
        {
          path: [],
          name: "HbA1c",
          relevance: "obligatory",
          result: "HbA1c 8.1 %",
        },
      ],
    });
    expect(model.calls).toHaveLength(2);
    expect(move).toMatchObject({ supportingResult: "HbA1c" });
  });
});
