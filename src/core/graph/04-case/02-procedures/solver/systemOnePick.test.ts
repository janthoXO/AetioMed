// `SystemOnePick` against a fake System One port and a scripted LLM: narrowing, nucleus, commit gate.
import { describe, expect, it, vi } from "vitest";
import type { GraphRuntime, SystemOnePort } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/adapters/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/adapters/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/adapters/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/adapters/catalog/diagnosis/index.js";
import { nucleus, SystemOnePick } from "./systemOnePick.js";
import type { ProcedureStrategy } from "./ports.js";

/** Probabilities by option label; unlisted options get 0. */
function portAnswering(p: Record<string, number>) {
  return {
    choice: vi.fn(
      async (_state: string, _instructions: string, options: string[]) =>
        Object.fromEntries(options.map((option) => [option, p[option] ?? 0]))
    ),
  } satisfies SystemOnePort;
}

// 5 procedures; `maxOptions: 4` forces one narrowing level.
function pickWith(port: SystemOnePort, commit: object = {}) {
  const structured = vi.fn().mockResolvedValue(commit);
  const runtime: GraphRuntime = {
    llm: { structured, text: vi.fn() },
    catalogs: {
      procedures: new InMemoryProcedureCatalog({
        procedures: [],
        categories: [
          {
            name: "Lab",
            procedures: [
              { name: "HbA1c" },
              { name: "Glucose" },
              { name: "Lipids" },
            ],
            categories: [],
          },
          {
            name: "Imaging",
            procedures: [{ name: "Chest X-ray" }, { name: "CT Thorax" }],
            categories: [],
          },
        ],
      }),
      anamnesis: new InMemoryAnamnesisCatalog(),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };
  const systemOne = { port, pickMass: 0.8, pickMax: 3, maxOptions: 4 };
  const pick = new SystemOnePick(runtime, systemOne, {} as ProcedureStrategy);
  return { pick, structured };
}

const view = {
  presentation: { chiefComplaint: "Polyuria and polydipsia" },
  ruledOutDiagnoses: [],
  iterationsRemaining: 6,
  previousProcedures: [],
};

describe("SystemOnePick.nextStep", () => {
  it("narrows to the chosen category, then orders its nucleus; no LLM before the first batch", async () => {
    const port = portAnswering({
      Lab: 0.9,
      Imaging: 0.1,
      "Lab › HbA1c": 0.6,
      "Lab › Glucose": 0.3,
      "Lab › Lipids": 0.1,
    });
    const { pick, structured } = pickWith(port);
    expect(await pick.nextStep(view)).toEqual({
      action: "order",
      procedures: [
        { path: ["Lab"], name: "HbA1c" },
        { path: ["Lab"], name: "Glucose" },
      ],
    });
    expect(port.choice.mock.calls.map(([, , options]) => options)).toEqual([
      ["Lab", "Imaging"],
      ["Lab › HbA1c", "Lab › Glucose", "Lab › Lipids"],
    ]);
    expect(structured).not.toHaveBeenCalled();
  });

  it("after the first batch, lets the LLM diagnose, else chooses only from what is left", async () => {
    const ordered = {
      ...view,
      previousProcedures: [
        {
          path: ["Lab"],
          name: "HbA1c",
          relevance: "obligatory" as const,
          result: "HbA1c 8.1 %",
        },
      ],
    };
    const port = portAnswering({ "Lab › Glucose": 1 });
    const diagnosed = pickWith(port, {
      action: "diagnose",
      diagnosisName: "Diabetes",
    });
    expect(await diagnosed.pick.nextStep(ordered)).toMatchObject({
      action: "diagnose",
      diagnosisName: "Diabetes",
    });
    expect(port.choice).not.toHaveBeenCalled();

    // 4 left, not < maxOptions: both categories open into a level of
    // procedures only, which is the pick; no third choice.
    expect(
      await pickWith(port, { action: "continue" }).pick.nextStep(ordered)
    ).toEqual({
      action: "order",
      procedures: [{ path: ["Lab"], name: "Glucose" }],
    });
    expect(port.choice).toHaveBeenCalledTimes(2);
    const [state, , options] = port.choice.mock.calls[1]!;
    expect(options).not.toContain("Lab › HbA1c");
    expect(state).toContain("HbA1c 8.1 %");
  });
});

describe("nucleus", () => {
  const ranked = [
    { option: "a", p: 0.5 },
    { option: "b", p: 0.3 },
    { option: "c", p: 0.15 },
    { option: "d", p: 0.05 },
  ];

  it("keeps the top options until their mass is reached, capped, at least one", () => {
    expect(nucleus(ranked, 0.8, 3)).toEqual(["a", "b"]);
    expect(nucleus(ranked, 0.99, 3)).toEqual(["a", "b", "c"]);
    expect(nucleus(ranked, 0.1, 3)).toEqual(["a"]);
  });
});
