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
  const graph = {
    config: { TRANSLATION_SANDWICH: true, LANGUAGES: ["en"] },
    runtime: { catalogs: { anamnesis: { list: () => undefined } } },
    planCase,
    renderCase,
    rerolls: { renderParts, replanUnit },
    translateOutline: undefined,
  } as unknown as GraphAppContext;
  const service = createCaseGenerationService(
    graph,
    new EventBus(),
    createJobEventChannel()
  );
  return { service, renderCase, renderParts, replanUnit, planCase };
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
