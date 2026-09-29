// Covers pure path/apply helpers of the "rest" pass (`caseTextMap`/`applyCaseTextTranslations`/
// `translateProcedureTree`), catalogue-backed `translate*FromEnglish` tools (cache-first), and
// `translateRestValues`'s prompt safety. Map has two keys per part (`.alt`/`.text`); see `tools.ts`.
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  caseTextMap,
  applyCaseTextTranslations,
  translateProcedureTree,
  translateProcedureNodesFromEnglish,
  translateAnamnesisCategoriesFromEnglish,
  translateRestValues,
} from "./tools.js";
import {
  encodeText,
  textOf,
  type ContentPart,
} from "@/core/graph/models/ContentPart.js";
import { nodeKey } from "@/core/graph/models/ProcedureTree.js";
import type { Case } from "@/core/graph/models/Case.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type {
  AnamnesisCatalog,
  ProcedureCatalog,
} from "@/core/graph/catalog/ports.js";
import { looksLikeByteDump } from "@/core/graph/utils/promptSafety.test.js";
import { renderForPrompt } from "@/core/graph/utils/prompt.js";

/** Local fixture builder. `alt` equals decoded `value`, so `.alt`/`.text` entries match for text parts; see `caseTextMap`. */
function fixtureTextPart(alt: string): ContentPart {
  return { type: "text/plain", value: encodeText(alt), alt };
}

function fakeRuntime(responses: string[]): GraphRuntime {
  return {
    llm: {
      for: () => new FakeListChatModel({ responses }),
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

/** Runtime whose `catalogs` are just the given fakes. */
function withCatalogs(
  runtime: GraphRuntime,
  catalogs: {
    procedures?: ProcedureCatalog;
    anamnesis?: AnamnesisCatalog;
  }
): GraphRuntime {
  return { ...runtime, catalogs } as unknown as GraphRuntime;
}

const unusedCandidates = () => {
  throw new Error("unused");
};

/** Throws if the LLM is ever invoked — proves a zero-LLM-call cache hit. */
function throwingRuntime(): GraphRuntime {
  return {
    llm: {
      for: () => {
        throw new Error("Unexpected LLM call — the test scripted zero.");
      },
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  } as unknown as GraphRuntime;
}

const mixedCase: Case = {
  chiefComplaint: [fixtureTextPart("Cough for three days.")],
  anamnesis: [
    {
      category: "History",
      answer: [fixtureTextPart("First."), fixtureTextPart("Second.")],
    },
  ],
  procedures: {
    procedures: [],
    categories: [
      {
        name: "Cardiology",
        categories: [],
        procedures: [
          {
            name: "Chest X-ray",
            order: 0,
            relevance: "obligatory",
            result: [
              fixtureTextPart("Infiltrate noted."),
              {
                type: "image/png",
                alt: "PA chest radiograph, right lower lobe consolidation.",
                value: new Uint8Array(200).fill(137),
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("caseTextMap — path/order keying, including procedures", () => {
  it("keys every part's alt, and additionally a text part's decoded value, by stable position — never by name", () => {
    const map = caseTextMap(mixedCase);

    expect(map).toEqual({
      "chiefComplaint.0.alt": "Cough for three days.",
      "chiefComplaint.0.text": "Cough for three days.",
      "anamnesis.0.answer.0.alt": "First.",
      "anamnesis.0.answer.0.text": "First.",
      "anamnesis.0.answer.1.alt": "Second.",
      "anamnesis.0.answer.1.text": "Second.",
      "procedures.0.result.0.alt": "Infiltrate noted.",
      "procedures.0.result.0.text": "Infiltrate noted.",
      // The image part contributes only `.alt` — its `value` is bytes, not
      // reachable text, so there is no `.text` entry for it.
      "procedures.0.result.1.alt":
        "PA chest radiograph, right lower lobe consolidation.",
    });
    // Never keyed on the procedure name — that is the defined pass's job,
    // and keying on it here would couple the two disjoint passes.
    expect(Object.keys(map).some((k) => k.includes("Chest X-ray"))).toBe(false);
  });
});

describe("applyCaseTextTranslations — chiefComplaint/anamnesis only", () => {
  it("a multi-part field survives with its part count and order intact", () => {
    const translated = applyCaseTextTranslations(mixedCase, {
      "anamnesis.0.answer.0.alt": "Premier (étiquette).",
      "anamnesis.0.answer.0.text": "Premier.",
      "anamnesis.0.answer.1.alt": "Deuxième (étiquette).",
      "anamnesis.0.answer.1.text": "Deuxième.",
    });

    expect(translated.anamnesis?.[0]?.answer).toHaveLength(2);
    expect(translated.anamnesis?.[0]?.answer.map((p) => p.alt)).toEqual([
      "Premier (étiquette).",
      "Deuxième (étiquette).",
    ]);
    expect(
      translated.anamnesis?.[0]?.answer.map((p) =>
        new TextDecoder().decode(p.value)
      )
    ).toEqual(["Premier.", "Deuxième."]);
  });

  it("applies the translated .text entry to value and the translated .alt entry to alt, independently, for a text/plain part", () => {
    const translated = applyCaseTextTranslations(mixedCase, {
      "chiefComplaint.0.alt": "Plainte principale (traduite).",
      "chiefComplaint.0.text": "Toux depuis trois jours.",
    });

    const part = translated.chiefComplaint![0]!;
    expect(part.type).toBe("text/plain");
    expect(part.alt).toBe("Plainte principale (traduite).");
    expect(new TextDecoder().decode(part.value)).toBe(
      "Toux depuis trois jours."
    );
    // Entries need not agree; that is why they are separate keys.
    expect(part.alt).not.toBe(new TextDecoder().decode(part.value));
  });

  it("a missing key falls back to the original alt/value, untouched", () => {
    const translated = applyCaseTextTranslations(mixedCase, {});
    expect(translated.chiefComplaint).toEqual(mixedCase.chiefComplaint);
  });

  it("leaves anamnesis[].category untouched — disjoint from the defined pass by construction", () => {
    const translated = applyCaseTextTranslations(mixedCase, {});
    expect(translated.anamnesis?.[0]?.category).toBe("History");
  });
});

describe("translateProcedureTree — node names and result parts in one walk", () => {
  it("translates category and leaf names from the defined map, and result parts from the rest map", () => {
    const translated = translateProcedureTree(
      mixedCase.procedures!,
      {
        [nodeKey(["Cardiology"])]: "Kardiologie",
        [nodeKey(["Cardiology", "Chest X-ray"])]: "Röntgen-Thorax",
      },
      {
        "procedures.0.result.0.alt": "Infiltrat notiert.",
        "procedures.0.result.0.text": "Infiltrat notiert.",
        "procedures.0.result.1.alt": "Röntgenbild Thorax.",
      }
    );

    expect(translated.categories[0]!.name).toBe("Kardiologie");
    const leaf = translated.categories[0]!.procedures[0]!;
    expect(leaf.name).toBe("Röntgen-Thorax");
    expect(leaf.order).toBe(0);
    expect(leaf.relevance).toBe("obligatory");
    expect(leaf.result[0]!.alt).toBe("Infiltrat notiert.");
    expect(new TextDecoder().decode(leaf.result[0]!.value)).toBe(
      "Infiltrat notiert."
    );
    // Non-text part: value byte-identical, only alt translated.
    expect(leaf.result[1]!.alt).toBe("Röntgenbild Thorax.");
    expect(leaf.result[1]!.value).toBe(
      mixedCase.procedures!.categories[0]!.procedures[0]!.result[1]!.value
    );
  });

  it("a miss in either map falls back to the original English value", () => {
    const translated = translateProcedureTree(mixedCase.procedures!, {}, {});
    expect(translated.categories[0]!.name).toBe("Cardiology");
    expect(translated.categories[0]!.procedures[0]!.name).toBe("Chest X-ray");
    expect(translated.categories[0]!.procedures[0]!.result).toEqual(
      mixedCase.procedures!.categories[0]!.procedures[0]!.result
    );
  });
});

describe("translateRestValues — no bytes reach the prompt", () => {
  it("negative control: looksLikeByteDump fires on the raw domain shape, so the assertion below is not vacuous", () => {
    // Exactly what handing `renderForPrompt` the raw ContentPart would look
    // like — mirrors `promptSafety.test.ts`'s own negative control.
    const leaked = renderForPrompt({
      result: [
        {
          type: "image/png",
          alt: "PA chest radiograph.",
          value: new Uint8Array(200).fill(137),
        },
      ],
    });
    expect(looksLikeByteDump(leaked)).toBe(true);
  });

  it("logs a prompt built only from alt text, never from `value` bytes", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const oneProcedureCase: Case = {
      procedures: {
        procedures: [],
        categories: [
          {
            name: "Cardiology",
            categories: [],
            procedures: [
              {
                name: "Chest X-ray",
                order: 0,
                relevance: "obligatory",
                result: [
                  {
                    type: "image/png",
                    alt: "PA chest radiograph, right lower lobe consolidation.",
                    value: new Uint8Array(500).fill(137),
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const values = caseTextMap(oneProcedureCase);
    const runtime = fakeRuntime([
      JSON.stringify({
        "procedures.0.result.0.alt": "Radiographie PA du thorax.",
      }),
    ]);

    await translateRestValues.invoke({ values, language: "French" }, runtime);

    // Only the single-string "SystemPrompt/UserPrompt" debug call — not
    // every debug call, several of which log non-string values whose
    // `.join(" ")` stringification would itself read as "[object Object]"
    // and falsely trip the detector.
    const promptLog = debugSpy.mock.calls
      .map((c) => c[0])
      .find(
        (arg): arg is string =>
          typeof arg === "string" && arg.includes("SystemPrompt")
      );
    expect(promptLog).toBeDefined();
    expect(looksLikeByteDump(promptLog!)).toBe(false);
    expect(promptLog).toContain("PA chest radiograph");

    debugSpy.mockRestore();
  });

  it("returns {} and never calls the LLM when there is nothing to translate", async () => {
    const result = await translateRestValues.invoke(
      { values: {}, language: "French" },
      throwingRuntime()
    );
    expect(result).toEqual({});
  });
});

describe("translateProcedureNodesFromEnglish — cache-first, unchanged", () => {
  it("makes zero LLM calls when every node is already cached, and returns the exact cached term", async () => {
    const catalog: ProcedureCatalog = {
      tree: () => undefined,
      candidates: unusedCandidates,
      translation: (key) =>
        key === nodeKey(["Cardiology", "Chest X-ray"])
          ? "Röntgen-Thorax"
          : undefined,
      saveTranslations: vi.fn(),
    };
    const tool = translateProcedureNodesFromEnglish;

    const result = await tool.invoke(
      {
        procedureNodes: [
          {
            key: nodeKey(["Cardiology", "Chest X-ray"]),
            name: "Chest X-ray",
          },
        ],
        language: "German",
      },
      withCatalogs(throwingRuntime(), { procedures: catalog })
    );

    // Exactly catalogue's target-language term; must not be overwritten by free-text LLM output
    // (`translate_merge` applies this map onto `case`, only writer).
    expect(result).toEqual({
      [nodeKey(["Cardiology", "Chest X-ray"])]: "Röntgen-Thorax",
    });
    expect(catalog.saveTranslations).not.toHaveBeenCalled();
  });

  it("calls the LLM once for the missing nodes and caches only those", async () => {
    const saved: Record<string, string>[] = [];
    const catalog: ProcedureCatalog = {
      tree: () => undefined,
      candidates: unusedCandidates,
      translation: (key) =>
        key === nodeKey(["Cardiology"]) ? "Kardiologie" : undefined,
      saveTranslations: (map) => void saved.push(map),
    };
    const tool = translateProcedureNodesFromEnglish;
    const runtime = withCatalogs(
      fakeRuntime([
        JSON.stringify({
          [nodeKey(["Cardiology", "Chest X-ray"])]: "Röntgen-Thorax",
        }),
      ]),
      { procedures: catalog }
    );

    const result = await tool.invoke(
      {
        procedureNodes: [
          { key: nodeKey(["Cardiology"]), name: "Cardiology" },
          {
            key: nodeKey(["Cardiology", "Chest X-ray"]),
            name: "Chest X-ray",
          },
        ],
        language: "German",
      },
      runtime
    );

    expect(result).toEqual({
      [nodeKey(["Cardiology"])]: "Kardiologie",
      [nodeKey(["Cardiology", "Chest X-ray"])]: "Röntgen-Thorax",
    });
    expect(saved).toEqual([
      { [nodeKey(["Cardiology", "Chest X-ray"])]: "Röntgen-Thorax" },
    ]);
  });
});

describe("translateAnamnesisCategoriesFromEnglish — cache-first, unchanged", () => {
  it("makes zero LLM calls when every category is already cached", async () => {
    const catalog: AnamnesisCatalog = {
      list: () => undefined,
      fromEnglish: (category) =>
        category === "History" ? "Anamnese" : undefined,
      saveTranslations: vi.fn(),
    };
    const tool = translateAnamnesisCategoriesFromEnglish;

    const result = await tool.invoke(
      { categories: ["History"], language: "German" },
      withCatalogs(throwingRuntime(), { anamnesis: catalog })
    );

    expect(result).toEqual({ History: "Anamnese" });
    expect(catalog.saveTranslations).not.toHaveBeenCalled();
  });
});

describe("textOf is unaffected (sanity: content-part semantics unchanged)", () => {
  it("still joins each part's text content with a blank line", () => {
    expect(
      textOf([fixtureTextPart("First."), fixtureTextPart("Second.")])
    ).toBe("First.\n\nSecond.");
  });
});
