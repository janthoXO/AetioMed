import { describe, expect, it, vi } from "vitest";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { parseTaggedOutline } from "@/core/graph/shared/outline/segments.js";
import { taggedOutlineFixture } from "@/core/graph/shared/outline/fixtures.js";
import { refineOutline } from "./refine.gateway.js";

const plan = parseTaggedOutline(
  taggedOutlineFixture({ anamnesisCategories: ["Allergies"] })
);

function runtimeAnswering(answer: unknown) {
  const structured = vi.fn(
    async (_c, _p, schema: { parse: (v: unknown) => unknown }) =>
      schema.parse(answer)
  );
  return {
    runtime: {
      llm: { structured },
      log: { error: vi.fn() },
    } as unknown as GraphRuntime,
    structured,
  };
}

const input = {
  plan,
  diagnosis: { name: "Influenza" },
  difficulty: "medium" as const,
  recipe: [],
  target: "the whole outline",
  request: "make the patient a child",
  language: undefined,
  call: { role: "judge" as const, temperature: "balanced" as const },
};

describe("refineOutline", () => {
  it("maps heading names back to segment indices", async () => {
    const { runtime } = runtimeAnswering({
      level: "outline",
      why: "age",
      affected: [{ heading: "### Allergies", why: "child" }],
      sections: [
        { heading: "## Patient", text: "6, male." },
        { heading: "### Allergies", text: "None." },
      ],
    });
    const r = await refineOutline(runtime, { ...input, levels: ["outline"] });
    expect(plan[3]!.text).toBe("## Patient");
    expect(plan[9]!.text).toBe("### Allergies");
    expect(r.sections).toEqual(
      new Map([
        [3, "6, male."],
        [9, "None."],
      ])
    );
    expect(r.affected).toEqual([{ index: 9, why: "child" }]);
  });

  it("rejects a heading not in the plan and a level not allowed (grammar)", async () => {
    for (const answer of [
      {
        level: "outline",
        why: "",
        affected: [],
        sections: [{ heading: "## Diagnosis", text: "x" }],
      },
      { level: "render", why: "", affected: [], sections: [] },
    ]) {
      const { runtime } = runtimeAnswering(answer);
      await expect(
        refineOutline(runtime, { ...input, levels: ["outline", "plan"] })
      ).rejects.toThrow();
    }
  });

  it("below outline level: no sections, whatever the model wrote", async () => {
    const { runtime } = runtimeAnswering({
      level: "plan",
      why: "codes only",
      affected: [{ heading: "## Patient", why: "x" }],
      sections: [{ heading: "## Patient", text: "x" }],
    });
    const r = await refineOutline(runtime, {
      ...input,
      levels: ["outline", "plan"],
    });
    expect(r).toMatchObject({ level: "plan", affected: [] });
    expect(r.sections.size).toBe(0);
  });
});
