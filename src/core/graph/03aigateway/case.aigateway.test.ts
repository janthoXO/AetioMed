// Covers §4/§6 of the medical-basis registry work: the basis section must
// never reach the system message, and the "select a subset" instruction
// that used to live inside the (now provider-owned) symptom data must live
// in the plan's own system-prompt instructions instead.
import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { generateCaseOutline } from "./case.aigateway.js";
import type { GraphRuntime, LlmPort } from "../runtime.js";
import { InMemoryProcedureCatalog } from "../catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "../catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "../catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "../catalog/diagnosis/index.js";
import type { BasisFragment } from "../medicalBasis/ports.js";

/** Captures every `invoke()` call's message list instead of a fixed reply. */
class CapturingChatModel extends BaseChatModel {
  calls: BaseMessage[][] = [];
  constructor(private readonly response: string) {
    super({});
  }
  _llmType() {
    return "capturing-fake";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    return {
      generations: [
        { message: new AIMessage(this.response), text: this.response },
      ],
    };
  }
}

function buildRuntime(model: CapturingChatModel): GraphRuntime {
  const llm: LlmPort = { for: () => model };
  return {
    llm,
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

const MARKER = "TOTALLY-UNIQUE-FRAGMENT-CONTENT-MARKER";

const fragments: BasisFragment[] = [
  {
    sourceId: "umls-symptoms",
    label: "Typical symptoms",
    content: MARKER,
    retrievedAt: "2024-01-01T00:00:00.000Z",
  },
];

describe("generateCaseOutline prompt shape", () => {
  it("never puts a fragment's content in the system message, only the user message", async () => {
    const model = new CapturingChatModel("outline text");
    const runtime = buildRuntime(model);

    await generateCaseOutline(
      runtime,
      { name: "Influenza", icd: "1E32" },
      ["patient"],
      fragments,
      "medium"
    );

    expect(model.calls).toHaveLength(1);
    const [systemMessage, humanMessage] = model.calls[0];

    expect(String(systemMessage.content)).not.toContain(MARKER);
    expect(String(humanMessage.content)).toContain(MARKER);
  });

  it("carries the 'select a clinically coherent subset' instruction in the system prompt, not in fragment data", async () => {
    const model = new CapturingChatModel("outline text");
    const runtime = buildRuntime(model);

    await generateCaseOutline(
      runtime,
      { name: "Influenza", icd: "1E32" },
      ["patient"],
      fragments,
      "medium"
    );

    const [systemMessage] = model.calls[0];
    expect(String(systemMessage.content)).toMatch(
      /select a clinically coherent subset/i
    );
  });

  it("with an empty registry, there is no 'Medical basis' section at all", async () => {
    const model = new CapturingChatModel("outline text");
    const runtime = buildRuntime(model);

    await generateCaseOutline(
      runtime,
      { name: "Influenza", icd: "1E32" },
      ["patient"],
      [],
      "medium"
    );

    const [, humanMessage] = model.calls[0];
    expect(String(humanMessage.content)).not.toContain("Medical basis");
  });
});
