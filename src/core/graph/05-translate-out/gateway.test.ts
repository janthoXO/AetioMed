// Covers the catalogue-backed `translate*FromEnglish` functions (cache-first) and
// `translateRestValues`'s prompt safety; see `gateway.ts`.
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { caseTextMap } from "./caseText.js";
import {
  translateProcedureNodesFromEnglish,
  translateAnamnesisCategoriesFromEnglish,
  translateRestValues,
} from "./gateway.js";
import { nodeKey } from "@/core/graph/shared/domain/ProcedureTree.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type {
  AnamnesisCatalog,
  ProcedureCatalog,
} from "@/core/graph/catalog/ports.js";
import { looksLikeByteDump } from "@/core/graph/shared/prompt/promptSafety.test.js";
import { renderForPrompt } from "@/core/graph/shared/prompt/prompt.js";

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

    await translateRestValues(runtime, { values, language: "French" });

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
    const result = await translateRestValues(throwingRuntime(), {
      values: {},
      language: "French",
    });
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

    const result = await translateProcedureNodesFromEnglish(
      withCatalogs(throwingRuntime(), { procedures: catalog }),
      {
        procedureNodes: [
          {
            key: nodeKey(["Cardiology", "Chest X-ray"]),
            name: "Chest X-ray",
          },
        ],
        language: "German",
      }
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
    const runtime = withCatalogs(
      fakeRuntime([
        JSON.stringify({
          [nodeKey(["Cardiology", "Chest X-ray"])]: "Röntgen-Thorax",
        }),
      ]),
      { procedures: catalog }
    );

    const result = await translateProcedureNodesFromEnglish(runtime, {
      procedureNodes: [
        { key: nodeKey(["Cardiology"]), name: "Cardiology" },
        {
          key: nodeKey(["Cardiology", "Chest X-ray"]),
          name: "Chest X-ray",
        },
      ],
      language: "German",
    });

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

    const result = await translateAnamnesisCategoriesFromEnglish(
      withCatalogs(throwingRuntime(), { anamnesis: catalog }),
      { categories: ["History"], language: "German" }
    );

    expect(result).toEqual({ History: "Anamnese" });
    expect(catalog.saveTranslations).not.toHaveBeenCalled();
  });
});
