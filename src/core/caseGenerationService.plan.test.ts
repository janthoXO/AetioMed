// Plan mode: no `plan` stops at `planned` (plan mode) or hands plan over via
// `onPlan` (normal mode); with `plan` skips planning. Graph faked at
// `planCase`/`renderCase`/`translateOutline`: tests service orchestration only.
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import {
  createCaseGenerationService,
  type PlanPayload,
} from "@/core/caseGenerationService.js";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import type {
  GraphAppContext,
  PlanCaseInput,
  RenderCaseInput,
} from "@/core/graph/appContext.js";
import {
  joinOutline,
  type OutlineSegments,
} from "@/core/graph/outline/segments.js";
import type { CaseGenerationRequest } from "@/api/index.js";

// Valid English skeleton (five fixed sections); `checkSkeleton` accepts.
const OUTLINE: OutlineSegments = [
  { fixed: false, text: "" },
  { fixed: true, text: "## General" },
  { fixed: false, text: "Chest pain for two hours." },
  { fixed: true, text: "## Patient" },
  { fixed: false, text: "58, male." },
  { fixed: true, text: "## Chief complaint" },
  { fixed: false, text: "Sharp pain." },
  { fixed: true, text: "## Anamnesis" },
  { fixed: false, text: "No relevant history." },
  { fixed: true, text: "## Procedures" },
  { fixed: false, text: "ECG only." },
];

type Fake = {
  graph: GraphAppContext;
  planCalls: PlanCaseInput[];
  renderCalls: RenderCaseInput[];
  translateCalls: { values: Record<string, string>; direction: string }[];
};

/** Graph faked at plan/case seam. `translateOutline`: out prefixes `DE:`, in swaps it for `EN:`. */
function fakeGraph(
  opts: { sandwich?: boolean; accepted?: boolean } = {}
): Fake {
  const planCalls: PlanCaseInput[] = [];
  const renderCalls: RenderCaseInput[] = [];
  const translateCalls: Fake["translateCalls"] = [];
  const sandwich = opts.sandwich ?? true;

  const graph = {
    config: {
      llm: { provider: "ollama", model: "test-model" },
      allowedLlms: undefined,
      LANGUAGES: ["English", "German"],
      LANGUAGE_AUTO_DETECT: false,
      LANGUAGE_DETECT_LLM_FALLBACK: false,
      TRANSLATION_SANDWICH: sandwich,
    } as GraphAppContext["config"],
    runtime: {
      catalogs: {
        diagnosis: { byIcd: () => undefined },
        anamnesis: { list: () => undefined },
      },
      llm: { for: vi.fn() },
    } as unknown as GraphAppContext["runtime"],
    async planCase(input: PlanCaseInput) {
      planCalls.push(input);
      return {
        diagnosis: input.diagnosis,
        userInstructions: input.userInstructions,
        basisFragments: [],
        outlineSegments: input.outline ?? OUTLINE,
        outlineAccepted: input.outline ? true : (opts.accepted ?? true),
      };
    },
    async renderCase(input: RenderCaseInput) {
      renderCalls.push(input);
      return { patient: { name: "Jane", age: 58, sex: "male" } };
    },
    translateOutline: sandwich
      ? vi.fn(
          async (values: Record<string, string>, direction: "out" | "in") => {
            translateCalls.push({ values, direction });
            return Object.fromEntries(
              Object.entries(values).map(([k, v]) => [
                k,
                direction === "out" ? `DE:${v}` : `EN:${v.replace(/^DE:/, "")}`,
              ])
            );
          }
        )
      : undefined,
  } as unknown as GraphAppContext;

  return { graph, planCalls, renderCalls, translateCalls };
}

function request(
  overrides: Partial<CaseGenerationRequest> = {}
): CaseGenerationRequest {
  return {
    diagnosis: "Influenza",
    generationFlags: ["patient"],
    mode: "plan",
    language: "German",
    ...overrides,
  } as CaseGenerationRequest;
}

function build(fake: Fake) {
  const channel = createJobEventChannel();
  const service = createCaseGenerationService(
    fake.graph,
    new EventBus(),
    channel
  );
  return { service, channel };
}

describe("plan mode — the stop at a plan", () => {
  it("sandwich on, German: stops 'planned' with the plan translated out; renderCase is never called", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);

    const result = await service.generate(request({ jobId: "j1" }));

    expect(result.status).toBe("planned");
    expect(result.language).toBe("German");
    expect(result.plan![2]).toEqual({
      fixed: false,
      text: "DE:Chest pain for two hours.",
    });
    // Fixed segments are translated for display too.
    expect(result.plan![1]!.text).toBe("DE:## General");
    expect(fake.renderCalls).toHaveLength(0);
  });

  it("sandwich off: the plan comes back as generated, translateOutline is never called", async () => {
    const fake = fakeGraph({ sandwich: false });
    const translateSpy = vi.fn();
    fake.graph.translateOutline = translateSpy as never;
    const { service } = build(fake);

    const result = await service.generate(request());

    expect(result.status).toBe("planned");
    expect(result.plan).toEqual(OUTLINE);
    expect(translateSpy).not.toHaveBeenCalled();
  });
});

describe("normal mode", () => {
  it("hands onPlan the English outline (mode 'normal') before the case is rendered", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    const onPlan = vi.fn();

    const result = await service.generate(request({ mode: "normal" }), {
      onPlan,
    });

    expect(result.status).toBe("done");
    expect(onPlan).toHaveBeenCalledWith({
      jobId: result.jobId,
      mode: "normal",
      language: "German",
      plan: OUTLINE,
    } satisfies PlanPayload);
    expect(fake.renderCalls[0]!.outline).toBe(joinOutline(OUTLINE));
    // Normal mode: no reviewer, no outline translation.
    expect(fake.translateCalls).toHaveLength(0);
  });

  it("fails with OUTLINE_NOT_ACCEPTED when the judge never accepted the outline", async () => {
    const fake = fakeGraph({ accepted: false });
    const { service } = build(fake);

    const result = await service.generate(request({ mode: "normal" }));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("OUTLINE_NOT_ACCEPTED");
    expect(fake.renderCalls).toHaveLength(0);
  });
});

describe("continuation, plan mode + sandwich on", () => {
  it("an unedited plan comes back as the original English with no translate-in call", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    const planned = await service.generate(request({ jobId: "cont-1" }));
    expect(planned.status).toBe("planned");

    const result = await service.generate(
      request({ jobId: "cont-1", plan: planned.plan })
    );

    expect(result.status).toBe("done");
    expect(
      fake.translateCalls.filter((c) => c.direction === "in")
    ).toHaveLength(0);
    expect(fake.planCalls[1]!.outline).toEqual(OUTLINE);
    expect(fake.renderCalls[0]!.outline).toBe(joinOutline(OUTLINE));
  });

  it("only the edited editable segment is translated in; a fixed heading is restored to English even if it also misses the cache and the translator mangles it", async () => {
    const fake = fakeGraph();
    // Translator mangles fixed headings; restoreSkeletonHeadings must keep
    // that from reaching checkSkeleton.
    fake.graph.translateOutline = vi.fn(
      async (values: Record<string, string>, direction: "out" | "in") => {
        fake.translateCalls.push({ values, direction });
        return Object.fromEntries(
          Object.entries(values).map(([k, v]) => [
            k,
            direction === "out"
              ? `DE:${v}`
              : k === "1"
                ? "Mangled heading nonsense"
                : `EN:${v.replace(/^DE:/, "")}`,
          ])
        );
      }
    ) as never;
    const { service } = build(fake);
    const planned = await service.generate(request({ jobId: "cont-2" }));
    expect(planned.status).toBe("planned");

    const edited = structuredClone(planned.plan!);
    edited[2]!.text = "DE:edited body";
    // Fixed heading not matching cached one: cache miss, forces translate-in.
    edited[1]!.text = "DE:## General (retyped)";

    const result = await service.generate(
      request({ jobId: "cont-2", plan: edited })
    );

    expect(result.status).toBe("done");
    const inCalls = fake.translateCalls.filter((c) => c.direction === "in");
    // Only the two cache-missing segments translated; rest from cache.
    expect(inCalls).toHaveLength(1);
    expect(inCalls[0]!.values).toEqual({
      "1": "DE:## General (retyped)",
      "2": "DE:edited body",
    });
    // Mangled heading discarded; English skeleton restored by position.
    expect(fake.planCalls[1]!.outline![1]!.text).toBe("## General");
    const expectedOutline = structuredClone(OUTLINE);
    expectedOutline[2]!.text = "EN:edited body";
    expect(fake.planCalls[1]!.outline).toEqual(expectedOutline);
  });

  it("planCase receives outline = the English plan; renderCase receives joinOutline(englishPlan)", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    const planned = await service.generate(request({ jobId: "cont-3" }));

    const result = await service.generate(
      request({ jobId: "cont-3", plan: planned.plan })
    );

    expect(result.status).toBe("done");
    expect(fake.planCalls[1]!.outline).toEqual(OUTLINE);
    expect(fake.renderCalls[0]!.outline).toBe(joinOutline(OUTLINE));
  });

  it("a broken skeleton fails with INVALID_PLAN, 400", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    const planned = await service.generate(request({ jobId: "cont-4" }));

    // Fewer than five fixed sections: restoreSkeletonHeadings leaves it
    // unchanged, checkSkeleton rejects.
    const broken = planned.plan!.slice(0, 5);

    const result = await service.generate(
      request({ jobId: "cont-4", plan: broken })
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "INVALID_PLAN",
      statusCode: 400,
    });
    expect(fake.renderCalls).toHaveLength(0);
  });
});

describe("continuation, sandwich off (any mode)", () => {
  it("plan mode: the plan goes straight in, no translation", async () => {
    const fake = fakeGraph({ sandwich: false });
    const translateSpy = vi.fn();
    fake.graph.translateOutline = translateSpy as never;
    const { service } = build(fake);
    const planned = await service.generate(request());
    expect(planned.status).toBe("planned");

    const edited = structuredClone(planned.plan!);
    edited[2]!.text = "Brustschmerz seit zwei Stunden.";

    const result = await service.generate(
      request({ jobId: planned.jobId, plan: edited })
    );

    expect(result.status).toBe("done");
    expect(translateSpy).not.toHaveBeenCalled();
    expect(fake.renderCalls[0]!.outline).toContain(
      "Brustschmerz seit zwei Stunden."
    );
  });

  it("normal mode: a plan handed back goes straight in too", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    const onPlan = vi.fn();
    await service.generate(request({ mode: "normal", jobId: "n1" }), {
      onPlan,
    });
    const englishPlan = onPlan.mock.calls[0]![0].plan as OutlineSegments;

    const edited = structuredClone(englishPlan);
    edited[2]!.text = "Edited body.";
    // Fresh jobId: normal mode never frees "n1"; models a client that already
    // has the English plan, not a continuation.
    const result = await service.generate(
      request({ mode: "normal", jobId: "n2", plan: edited })
    );

    expect(result.status).toBe("done");
    expect(fake.planCalls[1]!.outline).toEqual(edited);
    expect(fake.renderCalls[1]!.outline).toBe(joinOutline(edited));
  });
});

describe("jobId reuse across a plan stop", () => {
  it("the same jobId can be started again after a 'planned' stop", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    const planned = await service.generate(request({ jobId: "reuse-1" }));
    expect(planned.status).toBe("planned");

    const result = await service.generate(
      request({ jobId: "reuse-1", plan: planned.plan })
    );

    expect(result.status).toBe("done");
  });

  it("the same jobId cannot be started again after a 'done' stop", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    const done = await service.generate(
      request({ mode: "normal", jobId: "reuse-2" })
    );
    expect(done.status).toBe("done");

    const again = await service.generate(
      request({ mode: "normal", jobId: "reuse-2" })
    );

    expect(again.status).toBe("failed");
    expect(again.error).toMatchObject({
      code: "JOB_ALREADY_COMPLETED",
      statusCode: 409,
    });
  });
});
