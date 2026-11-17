// Reroll dispatch (#272): graph faked at renderCase / rerolls; checks which
// step runs per path depth and how the context's sources follow.
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import { createCaseGenerationService } from "@/core/caseGenerationService.js";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { CaseGenerationRequest } from "@/api/index.js";
import { encodeText } from "@/core/graph/shared/domain/ContentPart.js";
import type { OutlineSegments } from "@/core/graph/shared/outline/segments.js";
import { decodeContext, pathKey } from "./generationContext.js";
import {
  applySections,
  type PlanFacts,
  type Refinement,
} from "./graph/refine.js";
import { outlineSections } from "@/core/graph/shared/outline/segments.js";

const OUTLINE: OutlineSegments = [
  { fixed: false, text: "" },
  { fixed: true, text: "## General" },
  { fixed: false, text: "" },
  { fixed: true, text: "## Patient" },
  { fixed: false, text: "58, male." },
  { fixed: true, text: "## Chief complaint" },
  { fixed: false, text: "Sharp pain." },
  { fixed: true, text: "## Anamnesis" },
  { fixed: false, text: "None." },
  { fixed: true, text: "## Procedures" },
  { fixed: false, text: "ECG." },
];

const part = (alt: string, provider: string, unit: string) => ({
  type: "text/plain",
  value: encodeText(alt),
  alt,
  source: { provider, input: { alt }, unit },
});

function fake() {
  let round = 0;
  const renderCase = vi.fn(async () => {
    round++;
    return {
      chiefComplaint: [part(`cc${round}`, "text", "chiefComplaint")],
      anamnesis: [
        {
          category: "Allergien",
          answer: [part(`a${round}`, "text", "Allergies")],
        },
      ],
    };
  });
  const renderParts = vi.fn(async (_field: string, parts: { alt: string }[]) =>
    parts.map((p) => part(p.alt, "text", "x"))
  );
  const replanUnit = vi.fn(async () => [
    part("new a", "text", "Allergies"),
    part("new b", "image", "Allergies"),
  ]);
  const planCase = vi.fn(async () => ({
    diagnosis: { name: "Influenza" },
    outlineSegments: OUTLINE,
    outlineAccepted: true,
  }));
  const refinement: { current: Refinement } = {
    current: { level: "outline", why: "w", affected: [], sections: new Map() },
  };
  const refine = vi.fn(async () => refinement.current);
  const settle = vi.fn(
    async (facts: PlanFacts, sections: Map<number, string>) => ({
      plan: applySections(facts.plan, sections),
      sections,
    })
  );
  const graph = {
    config: { TRANSLATION_SANDWICH: true, LANGUAGES: ["en"] },
    runtime: { catalogs: { anamnesis: { list: () => undefined } } },
    planCase,
    renderCase,
    rerolls: { renderParts, replanUnit },
    refiner: { refine, settle },
    translateOutline: undefined,
  } as unknown as GraphAppContext;
  const service = createCaseGenerationService(
    graph,
    new EventBus(),
    createJobEventChannel()
  );
  return {
    service,
    renderCase,
    renderParts,
    replanUnit,
    planCase,
    refine,
    refinement,
  };
}

async function generated(f: ReturnType<typeof fake>) {
  const done = await f.service.generate({
    diagnosis: "Influenza",
    generationFlags: ["chiefComplaint", "anamnesis"],
    mode: "normal",
    language: "en",
  } as CaseGenerationRequest);
  return done.context!;
}

const regen = (context: string, regenerate: unknown[]) =>
  ({ language: "en", context, regenerate }) as CaseGenerationRequest;

describe("reroll by path depth", () => {
  it("field: case graph narrowed to the field; sources under it replaced", async () => {
    const f = fake();
    const context = await generated(f);
    const result = await f.service.generate(
      regen(context, [{ path: ["anamnesis"] }])
    );
    expect(f.renderCase).toHaveBeenLastCalledWith(
      expect.objectContaining({ generationFlags: ["anamnesis"] })
    );
    expect(result.pieces).toEqual([
      expect.objectContaining({ path: ["anamnesis"], how: "rerolled" }),
    ]);
    const after = decodeContext(result.context!);
    expect(after.parts[pathKey(["anamnesis", "Allergien", 0])]).toEqual({
      provider: "text",
      input: { alt: "a2" },
    });
    // Untouched field keeps its sources.
    expect(after.parts[pathKey(["chiefComplaint", 0])]!.input).toEqual({
      alt: "cc1",
    });
  });

  it("unit: re-plans the English unit key from the context, records its new parts", async () => {
    const f = fake();
    const context = await generated(f);
    const result = await f.service.generate(
      regen(context, [{ path: ["anamnesis", "Allergien"] }])
    );
    expect(f.replanUnit).toHaveBeenCalledWith(
      "anamnesis",
      "Allergies",
      expect.anything()
    );
    expect(result.pieces![0]!.value).toHaveLength(2);
    expect(
      decodeContext(result.context!).parts[
        pathKey(["anamnesis", "Allergien", 1])
      ]
    ).toEqual({ provider: "image", input: { alt: "new b" } });
  });

  it("part: renders again from recorded provider + input with the client's alt", async () => {
    const f = fake();
    const context = await generated(f);
    const result = await f.service.generate(
      regen(context, [{ path: ["chiefComplaint", 0], alts: ["edited alt"] }])
    );
    expect(f.renderParts).toHaveBeenCalledWith("chiefComplaint", [
      { provider: "text", input: { alt: "cc1" }, alt: "edited alt" },
    ]);
    expect(result.pieces![0]).toMatchObject({
      path: ["chiefComplaint", 0],
      value: { alt: "edited alt" },
    });
  });

  it("unknown unit or missing alts: INVALID_PATH, 400", async () => {
    const f = fake();
    const context = await generated(f);
    for (const entry of [
      { path: ["anamnesis", "Nope"] },
      { path: ["chiefComplaint", 0] },
    ]) {
      const result = await f.service.generate(regen(context, [entry]));
      expect(result.error).toMatchObject({
        code: "INVALID_PATH",
        statusCode: 400,
      });
    }
  });

  it("whole outline: plans again from the first call's inputs, stops at the plan", async () => {
    const f = fake();
    const context = await generated(f);
    const result = await f.service.generate(
      regen(context, [{ path: ["outline"] }])
    );
    expect(f.planCase).toHaveBeenCalledTimes(2);
    expect(f.planCase).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "plan",
        diagnosis: { name: "Influenza" },
      })
    );
    expect(result).toMatchObject({ status: "planned", plan: OUTLINE });
  });
});

describe("refine at outline level", () => {
  const childCase = (f: ReturnType<typeof fake>) => {
    f.refinement.current = {
      level: "outline",
      why: "child",
      affected: [
        { index: 3, why: "age 58 to 6" },
        { index: 5, why: "child's cough" },
      ],
      sections: new Map([
        [3, "6, male."],
        [5, "Cough."],
      ]),
    };
  };

  it("plan review: revised plan with the changed section indices, nothing rendered", async () => {
    const f = fake();
    const planned = await f.service.generate({
      diagnosis: "Influenza",
      generationFlags: ["patient"],
      mode: "plan",
      language: "en",
    } as CaseGenerationRequest);
    childCase(f);
    const result = await f.service.generate(
      regen(planned.context!, [{ path: ["outline", 3], instruction: "child" }])
    );
    expect(f.refine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: 'the section "## Patient"',
        levels: ["outline"],
      })
    );
    expect(result).toMatchObject({ status: "planned", changed: [3, 5] });
    expect(result.plan![4]!.text).toBe("6, male.");
    expect(f.renderCase).not.toHaveBeenCalled();
  });

  it("case: proposal maps sections to generated fields, the rest to background; accept composes and regenerates", async () => {
    const f = fake();
    const context = await generated(f);
    childCase(f);
    const proposed = await f.service.generate(
      regen(context, [
        {
          path: ["anamnesis", "Allergien"],
          instruction: "a child",
          alts: ["x"],
        },
      ])
    );
    expect(f.refine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: 'the anamnesis category "Allergies"',
        levels: ["outline", "plan"],
      })
    );
    expect(proposed).toMatchObject({
      status: "planned",
      proposal: {
        changed: [{ field: "chiefComplaint", why: "child's cough" }],
        background: [
          { section: 3, heading: "Patient", summary: "age 58 to 6" },
        ],
      },
    });

    const applied = await f.service.generate({
      language: "en",
      context: proposed.context!,
      accept: ["chiefComplaint"],
    } as CaseGenerationRequest);
    const expected = applySections(
      OUTLINE,
      new Map([
        [3, "6, male."],
        [5, "Cough."],
      ])
    );
    expect(f.renderCase).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generationFlags: ["chiefComplaint"],
        outlineSections: outlineSections(expected),
      })
    );
    expect(applied.pieces).toEqual([
      expect.objectContaining({ path: ["chiefComplaint"], how: "refined" }),
    ]);
    expect(decodeContext(applied.context!).proposal).toBeUndefined();
  });

  it("accept leaves a declined field's section old; background still taken", async () => {
    const f = fake();
    const context = await generated(f);
    childCase(f);
    const proposed = await f.service.generate(
      regen(context, [{ path: ["outline"], instruction: "a child" }])
    );
    await f.service.generate({
      language: "en",
      context: proposed.context!,
      accept: ["anamnesis"],
    } as CaseGenerationRequest);
    const sections = f.renderCase.mock.lastCall![0].outlineSections;
    expect(sections.patient).toBe("6, male.");
    expect(sections.chiefComplaint).toBe("Sharp pain.");
  });
});
