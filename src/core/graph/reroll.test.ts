import { describe, expect, it, vi } from "vitest";
import z from "zod";
import { InMemoryAnamnesisCatalog } from "@/adapters/catalog/anamnesis/index.js";
import { defineModalityProvider } from "@/core/graph/shared/modality/ports.js";
import type { GraphRuntime } from "./runtime.js";
import { makeRerolls } from "./reroll.js";

/** Planner answers `requests` for "Allergies"; providers echo their alt. */
function rerollsPlanning(requests: unknown[]) {
  const render = vi.fn(async (batch: { alt: string }[]) =>
    batch.map((b) => new TextEncoder().encode(b.alt))
  );
  const provider = (id: string) =>
    defineModalityProvider({
      id,
      mime: id === "text" ? "text/plain" : "image/svg+xml",
      description: id,
      inputSchema: z.object({ codes: z.array(z.string()).optional() }),
      render,
    });
  const runtime = {
    llm: {
      structured: vi.fn(async (_c, _p, schema: z.ZodType) =>
        schema.parse({ plans: { Allergies: { requests } } })
      ),
    },
    catalogs: { anamnesis: new InMemoryAnamnesisCatalog(["Allergies"]) },
    log: { error: vi.fn(), info: vi.fn() },
  } as unknown as GraphRuntime;
  const providers = [provider("text"), provider("image")];
  return {
    rerolls: makeRerolls(
      runtime,
      {
        anamnesis: providers,
        chiefComplaint: providers,
        procedureResult: providers,
      },
      false
    ),
    render,
  };
}

const sections = {
  patient: "58, male.",
  chiefComplaint: "",
  anamnesis: "### Allergies\nPenicillin.",
  procedures: "",
};

describe("replanUnit with a revision", () => {
  const current = [
    { provider: "image", input: { codes: ["N"] }, alt: "Normal ECG." },
    { provider: "text", input: {}, alt: "No allergies." },
  ];

  it("renders only the parts that differ from the current ones", async () => {
    const { rerolls, render } = rerollsPlanning([
      { provider: "image", input: { codes: ["N"] }, alt: "Normal ECG." },
      { provider: "text", input: {}, alt: "Penicillin allergy." },
    ]);
    const result = await rerolls.replanUnit("anamnesis", "Allergies", {
      diagnosis: { name: "x" },
      outlineSections: sections,
      revision: { instruction: "add penicillin", current, focus: 1 },
    });
    expect(result.changed).toEqual([1]);
    expect(result.parts.map((p) => p.alt)).toEqual(["Penicillin allergy."]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("a changed part count re-renders the whole unit, no `changed`", async () => {
    const { rerolls } = rerollsPlanning([
      { provider: "text", input: {}, alt: "Only text now." },
    ]);
    const result = await rerolls.replanUnit("anamnesis", "Allergies", {
      diagnosis: { name: "x" },
      outlineSections: sections,
      revision: { instruction: "text only", current },
    });
    expect(result.changed).toBeUndefined();
    expect(result.parts).toHaveLength(1);
  });
});
