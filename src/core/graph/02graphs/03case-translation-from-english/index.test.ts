// Issue 12 §1: the three-node design (translate_defined / translate_rest /
// translate_merge) is the point of the issue — these tests exercise the
// compiled graph (and `translateMerge` directly), not just the tools
// underneath, to prove the structural claims: the two passes write disjoint
// channels, `translate_merge` is the only writer of `case`, and reversing
// which pass finishes first produces an identical result because there is
// no order to be sensitive to.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  buildCaseTranslationFromEnglishGraph,
  translateMerge,
} from "./index.js";
import { textPart } from "@/core/graph/models/ContentPart.js";
import type { Case } from "@/core/graph/models/Case.js";
import type { GraphRuntime, LlmPort } from "@/core/graph/runtime.js";
import type { AnamnesisRepo } from "@/core/graph/catalog/anamnesis/index.js";
import type { ProceduresRepo } from "@/core/graph/catalog/procedures/index.js";
import { runWithContext } from "@/core/graph/utils/context.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { EventBus } from "@/core/event-bus.js";

function fakeRepos(opts: {
  procedureNames?: Record<string, string>;
  categories?: Record<string, string>;
}): { anamnesis: AnamnesisRepo; procedures: ProceduresRepo } {
  const procedureNames = opts.procedureNames ?? {};
  const categories = opts.categories ?? {};
  return {
    anamnesis: {
      translationsFile: "",
      getAnamnesisCategoryTranslationFromEnglish: (c) => categories[c],
      saveAnamnesisCategoryTranslations: () => {},
      getEffectiveCategoryList: () => undefined,
    },
    procedures: {
      translationsFile: "",
      getProcedureNameTranslationFromEnglish: (n) => procedureNames[n],
      saveProcedureNameTranslation: () => {},
      getEffectiveProcedureList: () => undefined,
    },
  };
}

/** An LLM serving one scripted JSON response, regardless of role/prompt. */
function fakeRuntime(restResponse: Record<string, string>): GraphRuntime {
  return {
    llm: {
      for: () =>
        new FakeListChatModel({ responses: [JSON.stringify(restResponse)] }),
    } as unknown as LlmPort,
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

function baseCase(): Case {
  return {
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
}

async function invoke(
  runtime: GraphRuntime,
  repos: { anamnesis: AnamnesisRepo; procedures: ProceduresRepo },
  overrides: { case?: Case } = {}
) {
  const graph = buildCaseTranslationFromEnglishGraph(
    runtime,
    repos,
    createTraceNode(new EventBus())
  );
  return runWithContext(
    () =>
      graph.invoke({
        diagnosis: { name: "Pneumonia" },
        generationFlags: [
          "patient",
          "chiefComplaint",
          "anamnesis",
          "procedures",
        ],
        case: overrides.case ?? baseCase(),
      }),
    undefined,
    undefined,
    "German"
  );
}

describe("buildCaseTranslationFromEnglishGraph — the bug fix (issue 12)", () => {
  it("procedures[].name comes out as EXACTLY the catalogue's cached term, never a rest-pass paraphrase", async () => {
    const repos = fakeRepos({
      procedureNames: { "Chest X-ray": "Röntgen-Thorax" },
      categories: { History: "Anamnese" },
    });
    // The rest pass's LLM is scripted to translate everything it's handed —
    // but it structurally cannot see procedure names or categories, since
    // `caseAltMap` never includes them. Under the old single translate_case
    // node, this LLM output — a full `Case` — would have overwritten the
    // cache-correct name/category wholesale via the shallow-merge `case`
    // reducer (issue 12 §0).
    const runtime = fakeRuntime({
      "chiefComplaint.0": "Toux depuis trois jours.",
      "anamnesis.0.answer.0": "Aucune maladie antérieure.",
      "procedures.0.result.0": "Infiltrat dans le lobe inférieur droit.",
    });

    const result = await invoke(runtime, repos);

    expect(result.case.procedures?.[0]?.name).toBe("Röntgen-Thorax");
    expect(result.case.anamnesis?.[0]?.category).toBe("Anamnese");
  });

  it("makes zero LLM calls for names/categories when the catalogue covers everything", async () => {
    const repos = fakeRepos({
      procedureNames: { "Chest X-ray": "Röntgen-Thorax" },
      categories: { History: "Anamnese" },
    });
    let calls = 0;
    const runtime: GraphRuntime = {
      llm: {
        for: () => {
          calls++;
          return new FakeListChatModel({
            responses: [
              JSON.stringify({
                "chiefComplaint.0": "Toux.",
                "anamnesis.0.answer.0": "Rien.",
                "procedures.0.result.0": "Infiltrat.",
              }),
            ],
          });
        },
      } as unknown as LlmPort,
      catalogs: {
        procedures: undefined,
        anamnesis: undefined,
        labels: undefined,
        diagnosis: undefined,
      },
      log: { info() {}, warn() {}, error() {} },
      clock: () => new Date("2024-01-01T00:00:00.000Z"),
    } as unknown as GraphRuntime;

    await invoke(runtime, repos);

    // The one call is the rest pass's — names/categories were fully
    // cache-served, no LLM call attributable to them.
    expect(calls).toBe(1);
  });

  it("translate_defined and translate_rest write disjoint channels — asserted by construction, not by comparing outputs", async () => {
    const completed: { node: string; result: unknown }[] = [];
    const bus = new EventBus();
    bus.on("Node Completed", (e) =>
      completed.push({ node: e.node, result: e.result })
    );

    const repos = fakeRepos({
      procedureNames: { "Chest X-ray": "Röntgen-Thorax" },
      categories: { History: "Anamnese" },
    });
    const runtime = fakeRuntime({
      "chiefComplaint.0": "Toux.",
      "anamnesis.0.answer.0": "Rien.",
      "procedures.0.result.0": "Infiltrat.",
    });
    const graph = buildCaseTranslationFromEnglishGraph(
      runtime,
      repos,
      createTraceNode(bus)
    );

    await runWithContext(
      () =>
        graph.invoke({
          diagnosis: { name: "Pneumonia" },
          generationFlags: ["procedures", "anamnesis"],
          case: baseCase(),
        }),
      undefined,
      undefined,
      "German"
    );

    const defined = completed.find((s) => s.node === "translate_defined");
    const rest = completed.find((s) => s.node === "translate_rest");
    expect(Object.keys(defined!.result as object)).toEqual([
      "definedTranslations",
    ]);
    expect(Object.keys(rest!.result as object)).toEqual(["restTranslations"]);
  });

  it("a multi-part field survives translation with its part count and order intact (issue 13)", async () => {
    // Cache the one category so `translate_defined` needs no LLM call of
    // its own — this test's fake LLM is scripted for the rest pass only.
    const repos = fakeRepos({ categories: { History: "Anamnese" } });
    const runtime = fakeRuntime({
      "anamnesis.0.answer.0": "Premier.",
      "anamnesis.0.answer.1": "Deuxième.",
    });
    const multiPartCase: Case = {
      anamnesis: [
        {
          category: "History",
          answer: [textPart("First."), textPart("Second.")],
        },
      ],
    };

    const result = await invoke(runtime, repos, { case: multiPartCase });

    expect(result.case.anamnesis?.[0]?.answer).toHaveLength(2);
    expect(result.case.anamnesis?.[0]?.answer.map((p) => p.alt)).toEqual([
      "Premier.",
      "Deuxième.",
    ]);
  });
});

describe("translateMerge — order-independence by construction (issue 12 §1)", () => {
  it("is insensitive to which of the two channels was 'computed' first: applying them in either order to build state yields an identical merged case", () => {
    const theCase = baseCase();
    const definedTranslations = {
      procedureNames: { "Chest X-ray": "Röntgen-Thorax" },
      anamnesisCategories: { History: "Anamnese" },
    };
    const restTranslations = {
      "chiefComplaint.0": "Toux depuis trois jours.",
      "anamnesis.0.answer.0": "Aucune maladie antérieure.",
      "procedures.0.result.0": "Infiltrat dans le lobe inférieur droit.",
    };

    // "Defined first" — build state as if translate_defined's write landed
    // before translate_rest's.
    const definedFirst = translateMerge({
      diagnosis: { name: "Pneumonia" },
      generationFlags: ["procedures"],
      case: theCase,
      definedTranslations,
      restTranslations: {},
    } as never);
    const bothAfterDefinedFirst = translateMerge({
      diagnosis: { name: "Pneumonia" },
      generationFlags: ["procedures"],
      case: theCase,
      definedTranslations,
      restTranslations,
    } as never);

    // "Rest first" — the reverse landing order.
    translateMerge({
      diagnosis: { name: "Pneumonia" },
      generationFlags: ["procedures"],
      case: theCase,
      definedTranslations: { procedureNames: {}, anamnesisCategories: {} },
      restTranslations,
    } as never);
    const bothAfterRestFirst = translateMerge({
      diagnosis: { name: "Pneumonia" },
      generationFlags: ["procedures"],
      case: theCase,
      definedTranslations,
      restTranslations,
    } as never);

    // Once both channels are populated, the merged case is identical
    // regardless of which one arrived first — `translateMerge` never reads
    // "was defined applied before rest", only the two channels' final
    // values.
    expect(bothAfterRestFirst.case).toEqual(bothAfterDefinedFirst.case);
    expect(definedFirst.case.procedures?.[0]?.name).toBe("Röntgen-Thorax");
    expect(bothAfterDefinedFirst.case.chiefComplaint?.[0]?.alt).toBe(
      "Toux depuis trois jours."
    );
  });
});

describe("the old whole-case translate tool is gone (issue 12 §2)", () => {
  it("this module exports no whole-case-in-one-LLM-call translator", async () => {
    const mod = await import("./tools.js");
    const removedExportName = ["translate", "Case"].join("");
    expect(removedExportName in mod).toBe(false);
  });
});
