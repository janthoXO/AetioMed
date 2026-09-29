// `selectProcedureLevel`: labels map back to items (off-level ones dropped), diagnose only when allowed, the diagnosis only in bridge mode.
import { chatModelLlmPort } from "@/adapters/ai/llm.js";
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { BaseMessage } from "@langchain/core/messages";
import { selectProcedureLevel } from "./gateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { LevelItem } from "@/core/graph/catalog/ports.js";
import { InMemoryProcedureCatalog } from "@/adapters/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/adapters/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/adapters/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/adapters/catalog/diagnosis/index.js";

/** Replies with `responses` in order; records every call's messages. */
class CapturingChatModel extends FakeListChatModel {
  calls: BaseMessage[][] = [];
  constructor(responses: string[]) {
    super({ responses });
  }
  override async _generate(
    ...args: Parameters<FakeListChatModel["_generate"]>
  ) {
    this.calls.push(args[0]);
    return super._generate(...args);
  }
}

function runtimeWith(model: CapturingChatModel): GraphRuntime {
  return {
    llm: chatModelLlmPort(() => model),
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

const items: LevelItem[] = [
  { kind: "category", path: ["Lab"], size: 350, sample: ["CBC", "CRP", "Na"] },
  { kind: "procedure", ref: { path: [], name: "Vitals" } },
];

const blinded = {
  mode: "blinded" as const,
  presentation: { chiefComplaint: "Fever" },
  previousProcedures: [],
  ruledOutDiagnoses: [],
  iterationsRemaining: 5,
};

const text = (messages: BaseMessage[]) =>
  messages.map((m) => String(m.content)).join("\n");

describe("selectProcedureLevel", () => {
  it("maps chosen labels back to level items, dropping repeats and labels not on this level", async () => {
    const model = new CapturingChatModel([
      JSON.stringify({
        action: "select",
        items: ["Lab", "Invented", "Vitals", "Lab"],
      }),
    ]);
    const selection = await selectProcedureLevel(
      runtimeWith(model),
      { ...blinded, allowDiagnose: true },
      items
    );
    expect(selection).toEqual({
      action: "select",
      items,
      reasoning: undefined,
    });
  });

  it("offers diagnose only when allowed", async () => {
    const reply = JSON.stringify({ action: "select", items: ["Vitals"] });
    const withDiagnose = new CapturingChatModel([reply]);
    const without = new CapturingChatModel([reply]);
    await selectProcedureLevel(
      runtimeWith(withDiagnose),
      { ...blinded, allowDiagnose: true },
      items
    );
    await selectProcedureLevel(
      runtimeWith(without),
      { ...blinded, allowDiagnose: false },
      items
    );
    expect(text(withDiagnose.calls[0]!)).toContain('"diagnose"');
    expect(text(without.calls[0]!)).not.toContain('"diagnose"');
  });

  it("shows the true diagnosis in bridge mode only", async () => {
    const reply = JSON.stringify({ action: "select", items: ["Lab"] });
    const blindModel = new CapturingChatModel([reply]);
    const bridgeModel = new CapturingChatModel([reply]);
    await selectProcedureLevel(
      runtimeWith(blindModel),
      { ...blinded, allowDiagnose: true },
      items
    );
    await selectProcedureLevel(
      runtimeWith(bridgeModel),
      {
        mode: "bridge",
        presentation: blinded.presentation,
        diagnosis: { name: "Influenza", icd: "1E32" },
        previousProcedures: [],
      },
      items
    );
    expect(text(blindModel.calls[0]!)).not.toContain("Influenza");
    expect(text(bridgeModel.calls[0]!)).toContain("Influenza");
  });
});
