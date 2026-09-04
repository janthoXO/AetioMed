// Issue 12: the old whole-case, single-LLM-call translate tool is gone —
// grepping this repo for its removed camelCase export name returns nothing.
// This suite covers what replaced it: the pure path/apply helpers the "rest"
// pass is built from
// (`caseAltMap`/`applyCaseAltTranslations`), the catalogue-backed
// `translate*FromEnglish` tools (unchanged underneath, still cache-first),
// and `translateRestValues`'s prompt safety.
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  caseAltMap,
  applyCaseAltTranslations,
  createTranslateProcedureNamesFromEnglish,
  createTranslateAnamnesisCategoriesFromEnglish,
  translateRestValues,
} from "./tools.js";
import { textOf, textPart } from "@/core/graph/models/ContentPart.js";
import type { Case } from "@/core/graph/models/Case.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";
import { looksLikeByteDump } from "@/core/graph/utils/promptSafety.test.js";
import { renderForPrompt } from "@/core/graph/utils/prompt.js";

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

describe("caseAltMap / applyCaseAltTranslations — the rest pass's path keying (issue 12 §2)", () => {
  const mixedCase: Case = {
    chiefComplaint: [textPart("Cough for three days.")],
    anamnesis: [
      {
        category: "History",
        answer: [textPart("First."), textPart("Second.")],
      },
    ],
    procedures: [
      {
        name: "Chest X-ray",
        relevance: "obligatory",
        result: [
          textPart("Infiltrate noted."),
          {
            type: "image/png",
            alt: "PA chest radiograph, right lower lobe consolidation.",
            value: new Uint8Array(200).fill(137),
          },
        ],
      },
    ],
  };

  it("keys every ContentPart.alt by stable position, never by name", () => {
    const map = caseAltMap(mixedCase);

    expect(map).toEqual({
      "chiefComplaint.0": "Cough for three days.",
      "anamnesis.0.answer.0": "First.",
      "anamnesis.0.answer.1": "Second.",
      "procedures.0.result.0": "Infiltrate noted.",
      "procedures.0.result.1":
        "PA chest radiograph, right lower lobe consolidation.",
    });
    // Never keyed on the procedure name — that is the defined pass's job,
    // and keying on it here would couple the two disjoint passes.
    expect(Object.keys(map).some((k) => k.includes("Chest X-ray"))).toBe(false);
  });

  it("a multi-part field survives with its part count and order intact (issue 13)", () => {
    const translated = applyCaseAltTranslations(mixedCase, {
      "anamnesis.0.answer.0": "Premier.",
      "anamnesis.0.answer.1": "Deuxième.",
    });

    expect(translated.anamnesis?.[0]?.answer).toHaveLength(2);
    expect(translated.anamnesis?.[0]?.answer.map((p) => p.alt)).toEqual([
      "Premier.",
      "Deuxième.",
    ]);
  });

  it("re-derives `value` from the translated `alt` for a text/plain part (value === utf8(alt))", () => {
    const translated = applyCaseAltTranslations(mixedCase, {
      "chiefComplaint.0": "Toux depuis trois jours.",
    });

    const part = translated.chiefComplaint![0]!;
    expect(part.alt).toBe("Toux depuis trois jours.");
    expect(new TextDecoder().decode(part.value)).toBe(part.alt);
  });

  it("a non-text part's value is byte-identical after translation, while only its alt is translated", () => {
    const originalValue = mixedCase.procedures![0]!.result[1]!.value;
    const translated = applyCaseAltTranslations(mixedCase, {
      "procedures.0.result.1": "Radiographie PA du thorax.",
    });

    const part = translated.procedures![0]!.result[1]!;
    expect(part.alt).toBe("Radiographie PA du thorax.");
    expect(part.value).toBe(originalValue); // same Uint8Array instance
    expect(part.type).toBe("image/png");
  });

  it("a missing key falls back to the original alt/value, untouched", () => {
    const translated = applyCaseAltTranslations(mixedCase, {});
    expect(translated.chiefComplaint).toEqual(mixedCase.chiefComplaint);
    expect(translated.procedures).toEqual(mixedCase.procedures);
  });

  it("leaves procedures[].name and anamnesis[].category untouched — disjoint from the defined pass by construction", () => {
    const translated = applyCaseAltTranslations(mixedCase, {
      "procedures.0.result.0": "Infiltrat noté.",
    });
    // Passed through as-is; `translate_merge` is what overlays
    // `definedTranslations` onto these two fields, not this function.
    expect(translated.procedures?.[0]?.name).toBe("Chest X-ray");
    expect(translated.anamnesis?.[0]?.category).toBe("History");
  });
});

describe("translateRestValues — no bytes reach the prompt (issue 12 §2/§4)", () => {
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
    const mixedCase: Case = {
      procedures: [
        {
          name: "Chest X-ray",
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
    };
    const values = caseAltMap(mixedCase);
    const runtime = fakeRuntime([
      JSON.stringify({
        "procedures.0.result.0": "Radiographie PA du thorax.",
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

describe("translateProcedureNamesFromEnglish — cache-first, unchanged (issue 12 §1)", () => {
  it("makes zero LLM calls when every name is already cached, and returns the exact cached term", async () => {
    const repo: ProceduresRepo = {
      translationsFile: "",
      getProcedureNameTranslationFromEnglish: (name) =>
        name === "Chest X-ray" ? "Röntgen-Thorax" : undefined,
      saveProcedureNameTranslation: vi.fn(),
      getEffectiveProcedureList: () => undefined,
    };
    const tool = createTranslateProcedureNamesFromEnglish(repo);

    const result = await tool.invoke(
      { procedureNames: ["Chest X-ray"], language: "German" },
      throwingRuntime()
    );

    // Exactly the catalogue's target-language term — not a paraphrase. This
    // is the bug issue 12 fixes: under the old single translate_values node,
    // this cached term was subsequently overwritten by whatever the
    // free-text LLM call echoed back for `procedures`, via the `case`
    // state's shallow-merge reducer (see `index.ts`'s `translate_merge`,
    // which now applies this map directly onto `case` and is the only node
    // that writes it).
    expect(result).toEqual({ "Chest X-ray": "Röntgen-Thorax" });
    expect(repo.saveProcedureNameTranslation).not.toHaveBeenCalled();
  });

  it("calls the LLM and caches only the missing names", async () => {
    const saved: Record<string, string>[] = [];
    const repo: ProceduresRepo = {
      translationsFile: "",
      getProcedureNameTranslationFromEnglish: (name) =>
        name === "CBC" ? "Blutbild" : undefined,
      saveProcedureNameTranslation: (map) => saved.push(map),
      getEffectiveProcedureList: () => undefined,
    };
    const tool = createTranslateProcedureNamesFromEnglish(repo);
    const runtime = fakeRuntime([
      JSON.stringify({ "Chest X-ray": "Röntgen-Thorax" }),
    ]);

    const result = await tool.invoke(
      { procedureNames: ["CBC", "Chest X-ray"], language: "German" },
      runtime
    );

    expect(result).toEqual({
      CBC: "Blutbild",
      "Chest X-ray": "Röntgen-Thorax",
    });
    expect(saved).toEqual([{ "Chest X-ray": "Röntgen-Thorax" }]);
  });
});

describe("translateAnamnesisCategoriesFromEnglish — cache-first, unchanged (issue 12 §1)", () => {
  it("makes zero LLM calls when every category is already cached", async () => {
    const repo: AnamnesisRepo = {
      translationsFile: "",
      getAnamnesisCategoryTranslationFromEnglish: (category) =>
        category === "History" ? "Anamnese" : undefined,
      saveAnamnesisCategoryTranslations: vi.fn(),
      getEffectiveCategoryList: () => undefined,
    };
    const tool = createTranslateAnamnesisCategoriesFromEnglish(repo);

    const result = await tool.invoke(
      { categories: ["History"], language: "German" },
      throwingRuntime()
    );

    expect(result).toEqual({ History: "Anamnese" });
    expect(repo.saveAnamnesisCategoryTranslations).not.toHaveBeenCalled();
  });
});

describe("textOf is unaffected (sanity: content-part semantics unchanged)", () => {
  it("still joins alt text with a blank line", () => {
    expect(textOf([textPart("First."), textPart("Second.")])).toBe(
      "First.\n\nSecond."
    );
  });
});
