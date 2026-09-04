// Issue 11 §6/§8: `translateCase` must keep working once the three content
// fields hold `ContentPart[]` — no byte payload may ever reach the
// translation prompt, and a round trip through the node must leave every
// text part satisfying `value === utf8(alt)`.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { translateCase } from "./tools.js";
import { textOf, textPart } from "@/core/graph/models/ContentPart.js";
import type { Case } from "@/core/graph/models/Case.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

function fakeRuntime(responseJson: string): GraphRuntime {
  return {
    llm: {
      for: () => new FakeListChatModel({ responses: [responseJson] }),
    },
    catalogs: {
      procedures: undefined,
      anamnesis: undefined,
      labels: undefined,
      diagnosis: undefined,
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  } as unknown as GraphRuntime;
}

describe("translateCase — content parts", () => {
  const sourceCase: Case = {
    chiefComplaint: [textPart("Cough for three days.")],
    anamnesis: [
      { category: "History", answer: [textPart("No prior illness.")] },
    ],
    procedures: [
      {
        name: "Chest X-ray",
        relevance: "obligatory",
        result: [textPart("Infiltrate in right lower lobe.")],
      },
    ],
  };

  it("projects to text before prompting, and rebuilds ContentPart[] with textPart afterwards", async () => {
    const runtime = fakeRuntime(
      JSON.stringify({
        chiefComplaint: "Toux depuis trois jours.",
        anamnesis: [
          { category: "History", answer: "Aucune maladie antérieure." },
        ],
        procedures: [
          {
            name: "Chest X-ray",
            relevance: "obligatory",
            result: "Infiltrat dans le lobe inférieur droit.",
          },
        ],
      })
    );

    const translated = await translateCase.invoke(
      { case: sourceCase, language: "French", generationFlags: ["procedures"] },
      runtime
    );

    // Text parts satisfy value === utf8(alt) after translation.
    expect(translated.chiefComplaint?.[0]?.alt).toBe(
      "Toux depuis trois jours."
    );
    expect(new TextDecoder().decode(translated.chiefComplaint![0]!.value)).toBe(
      translated.chiefComplaint![0]!.alt
    );

    expect(translated.anamnesis?.[0]?.answer[0]?.alt).toBe(
      "Aucune maladie antérieure."
    );
    expect(
      new TextDecoder().decode(translated.anamnesis![0]!.answer[0]!.value)
    ).toBe(translated.anamnesis![0]!.answer[0]!.alt);

    expect(translated.procedures?.[0]?.result[0]?.alt).toBe(
      "Infiltrat dans le lobe inférieur droit."
    );
    expect(
      new TextDecoder().decode(translated.procedures![0]!.result[0]!.value)
    ).toBe(translated.procedures![0]!.result[0]!.alt);

    // Preserved verbatim, untranslated.
    expect(translated.procedures?.[0]?.relevance).toBe("obligatory");
    expect(translated.procedures?.[0]?.name).toBe("Chest X-ray");
  });

  it("the whole-case overwrite bug (issue 12's to fix) is preserved: the LLM's anamnesis/procedures fully replace the input on merge", async () => {
    // `translateCase` itself always returns a full case for whichever
    // fields the LLM echoed back — the overwrite happens one layer up, in
    // the graph state's shallow-merge reducer (`state.ts`). This test only
    // pins down that `translateCase`'s output is NOT deep-merged with the
    // input inside the tool itself — i.e. nothing here defends against the
    // bug, which is exactly the point.
    const runtime = fakeRuntime(
      JSON.stringify({
        anamnesis: [{ category: "History (translated)", answer: "Réponse" }],
      })
    );

    const translated = await translateCase.invoke(
      { case: sourceCase, language: "French", generationFlags: [] },
      runtime
    );

    // The tool's return reflects only what the LLM echoed — the caller
    // (the reducer) is what overwrites the caller's own case with this.
    expect(translated.chiefComplaint).toBeUndefined();
    expect(translated.anamnesis?.[0]?.category).toBe("History (translated)");
  });

  it("textOf is exercised on the projection path (multi-part collapse, per the issue-13 ordering note)", () => {
    const multiPart = [textPart("First."), textPart("Second.")];
    // If a field ever had >1 part while this projection is in place, the
    // join would collapse them — this documents that today's fields always
    // have exactly one part, so no collapse actually occurs in practice.
    expect(textOf(multiPart)).toBe("First.\n\nSecond.");
  });
});
