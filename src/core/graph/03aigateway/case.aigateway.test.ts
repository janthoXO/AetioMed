// Basis section never reaches system message; "select a subset" instruction
// lives in plan's own system prompt.
import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { generateCaseOutline } from "./case.aigateway.js";
import { runWithContext } from "../utils/context.js";
import type { GraphRuntime, LlmPort } from "../runtime.js";
import { InMemoryProcedureCatalog } from "../catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "../catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "../catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "../catalog/diagnosis/index.js";
import type { BasisFragment } from "../medicalBasis/ports.js";
import { taggedOutlineFixture } from "../outline/fixtures.js";

/**
 * Captures every `invoke()` call's message list. Replies with `responses`
 * in order, repeating the last one.
 */
class CapturingChatModel extends BaseChatModel {
  calls: BaseMessage[][] = [];
  private readonly responses: string[];
  constructor(...responses: string[]) {
    super({});
    this.responses = responses;
  }
  _llmType() {
    return "capturing-fake";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const response =
      this.responses[Math.min(this.calls.length, this.responses.length) - 1]!;
    return {
      generations: [{ message: new AIMessage(response), text: response }],
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
    const model = new CapturingChatModel(taggedOutlineFixture());
    const runtime = buildRuntime(model);

    await generateCaseOutline(
      runtime,
      { name: "Influenza", icd: "1E32" },
      fragments,
      "medium"
    );

    expect(model.calls).toHaveLength(1);
    const [systemMessage, humanMessage] = model.calls[0];

    expect(String(systemMessage.content)).not.toContain(MARKER);
    expect(String(humanMessage.content)).toContain(MARKER);
  });

  it("carries the 'select a clinically coherent subset' instruction in the system prompt, not in fragment data", async () => {
    const model = new CapturingChatModel(taggedOutlineFixture());
    const runtime = buildRuntime(model);

    await generateCaseOutline(
      runtime,
      { name: "Influenza", icd: "1E32" },
      fragments,
      "medium"
    );

    const [systemMessage] = model.calls[0];
    expect(String(systemMessage.content)).toMatch(
      /select a clinically coherent subset/i
    );
  });

  it("with an empty registry, there is no 'Medical basis' section at all", async () => {
    const model = new CapturingChatModel(taggedOutlineFixture());
    const runtime = buildRuntime(model);

    await generateCaseOutline(
      runtime,
      { name: "Influenza", icd: "1E32" },
      [],
      "medium"
    );

    const [, humanMessage] = model.calls[0];
    expect(String(humanMessage.content)).not.toContain("Medical basis");
  });
});

describe("generateCaseOutline skeleton", () => {
  it("returns the outline as positional segments, fixed headings at odd indices", async () => {
    const model = new CapturingChatModel(taggedOutlineFixture());
    const segments = await generateCaseOutline(
      buildRuntime(model),
      { name: "Influenza" },
      [],
      "medium"
    );

    expect(segments.filter((s) => s.fixed).map((s) => s.text)).toEqual([
      "## General",
      "## Patient",
      "## Chief complaint",
      "## Anamnesis",
      "## Procedures",
    ]);
    expect(segments.every((s, i) => s.fixed === (i % 2 === 1))).toBe(true);
  });

  it("retries an off-skeleton outline, feeding the mismatch back to the model", async () => {
    const model = new CapturingChatModel(
      "<fixed>## Patient</fixed>\nWrong order.",
      taggedOutlineFixture()
    );
    await generateCaseOutline(
      buildRuntime(model),
      { name: "Influenza" },
      [],
      "medium"
    );

    expect(model.calls).toHaveLength(2);
    const [, retryHuman] = model.calls[1]!;
    expect(String(retryHuman!.content)).toMatch(/fixed headings are wrong/);
  });

  it("stays internal (no language directive) unless the caller binds it to the request language", async () => {
    const model = new CapturingChatModel(taggedOutlineFixture());
    const runtime = buildRuntime(model);

    await runWithContext(
      () =>
        generateCaseOutline(runtime, { name: "Grippe" }, [], "medium", {
          audience: "user-facing",
        }),
      "job",
      undefined,
      "German"
    );
    await runWithContext(
      () => generateCaseOutline(runtime, { name: "Grippe" }, [], "medium"),
      "job",
      undefined,
      "German"
    );

    expect(String(model.calls[0]![0]!.content)).toContain(
      "Output language: German"
    );
    expect(String(model.calls[1]![0]!.content)).not.toContain(
      "Output language"
    );
  });
});
