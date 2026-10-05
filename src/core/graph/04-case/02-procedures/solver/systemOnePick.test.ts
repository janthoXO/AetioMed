// `SystemOnePick` against a fake System One port and a scripted LLM: threshold, cap, top-1 fallback, commit gate.
import { describe, expect, it, vi } from "vitest";
import type { GraphRuntime, SystemOnePort } from "@/core/graph/runtime.js";
import { InMemoryProcedureCatalog } from "@/adapters/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/adapters/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/adapters/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/adapters/catalog/diagnosis/index.js";
import { SystemOnePick } from "./systemOnePick.js";
import type { ProcedureStrategy } from "./ports.js";

const NAMES = ["Vitals", "HbA1c", "Glucose", "Chest X-ray"];

/** P(yes) by procedure name, looked up through the question text. */
function portAnswering(p: Record<string, number>) {
  return {
    noul: vi.fn(async (_state: string, questions: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(questions).map(([key, text]) => [
          key,
          p[NAMES.find((name) => text.includes(`"${name}"`))!] ?? 0,
        ])
      )
    ),
  } satisfies SystemOnePort;
}

function pickWith(port: SystemOnePort, commit: object = {}) {
  const structured = vi.fn().mockResolvedValue(commit);
  const runtime: GraphRuntime = {
    llm: { structured, text: vi.fn() },
    catalogs: {
      procedures: new InMemoryProcedureCatalog({
        procedures: NAMES.map((name) => ({ name })),
        categories: [],
      }),
      anamnesis: new InMemoryAnamnesisCatalog(),
      labels: new InMemoryLabelCatalog(),
      diagnosis: new InMemoryDiagnosisCatalog(),
    },
    log: { info() {}, warn() {}, error() {} },
    clock: () => new Date("2024-01-01T00:00:00.000Z"),
  };
  const systemOne = { port, pickThreshold: 0.5, pickMax: 2 };
  const pick = new SystemOnePick(runtime, systemOne, {} as ProcedureStrategy);
  return { pick, structured };
}

const view = {
  presentation: { chiefComplaint: "Polyuria and polydipsia" },
  ruledOutDiagnoses: [],
  iterationsRemaining: 6,
  previousProcedures: [],
};

const ordered = {
  ...view,
  previousProcedures: [
    {
      path: [],
      name: "HbA1c",
      relevance: "obligatory" as const,
      result: "HbA1c 8.1 %",
    },
  ],
};

describe("SystemOnePick.nextStep", () => {
  it("orders the candidates at or over the threshold, highest first, capped; no LLM before the first batch", async () => {
    const port = portAnswering({
      Vitals: 0.6,
      HbA1c: 0.9,
      Glucose: 0.8,
      "Chest X-ray": 0.1,
    });
    const { pick, structured } = pickWith(port);
    expect(await pick.nextStep(view)).toEqual({
      action: "order",
      procedures: [
        { path: [], name: "HbA1c" },
        { path: [], name: "Glucose" },
      ],
    });
    expect(structured).not.toHaveBeenCalled();
  });

  it("orders the single best candidate when none passes", async () => {
    const { pick } = pickWith(portAnswering({ Glucose: 0.3, Vitals: 0.2 }));
    expect(await pick.nextStep(view)).toEqual({
      action: "order",
      procedures: [{ path: [], name: "Glucose" }],
    });
  });

  it("after the first batch, lets the LLM diagnose, else asks only about what is left", async () => {
    const port = portAnswering({ Glucose: 0.9 });
    const diagnosed = pickWith(port, {
      action: "diagnose",
      diagnosisName: "Diabetes",
    });
    expect(await diagnosed.pick.nextStep(ordered)).toMatchObject({
      action: "diagnose",
      diagnosisName: "Diabetes",
    });
    expect(port.noul).not.toHaveBeenCalled();

    const continued = pickWith(port, { action: "continue" });
    await continued.pick.nextStep(ordered);
    const questions = Object.values(port.noul.mock.calls[0]![1]).join("\n");
    expect(questions).not.toContain('"HbA1c"');
    expect(port.noul.mock.calls[0]![0]).toContain("HbA1c 8.1 %");
  });
});
