// Plan mode (#159): a job stops at a review, continues on a decision, and
// recovers from its checkpoints after a restart. The graph is faked at the
// plan/case seam — `planCase`, `renderCase`, `translateOutline` — so these
// tests exercise the service's orchestration, not LLM behaviour.
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import {
  createCaseGenerationService,
  type CaseGenerationResult,
} from "@/core/caseGenerationService.js";
import {
  createJobEventChannel,
  type JobEvent,
} from "@/core/jobEvents/index.js";
import type {
  GraphAppContext,
  PlanCaseInput,
  RenderCaseInput,
} from "@/core/graph/appContext.js";
import type { OutlineSegments } from "@/core/graph/outline/segments.js";
import { createInMemoryJobRecordRepo } from "@/core/jobs/memoryRepo.js";
import { createSecretBox } from "@/core/jobs/secretBox.js";
import type { JobRecordRepo } from "@/core/jobs/repo.js";
import type { CaseGenerationRequest } from "@/api/index.js";

const OUTLINE: OutlineSegments = [
  { fixed: false, text: "" },
  { fixed: true, text: "## General" },
  { fixed: false, text: "Chest pain for two hours." },
  { fixed: true, text: "## Patient" },
  { fixed: false, text: "58, male." },
];

type Fake = {
  graph: GraphAppContext;
  planCalls: PlanCaseInput[];
  renderCalls: RenderCaseInput[];
  translateCalls: { values: Record<string, string>; direction: string }[];
};

/**
 * A graph faked at the plan/case seam. `translateOutline` marks direction
 * so a test can see exactly which segments were translated: out prefixes
 * `DE:`, in replaces it with `EN:`.
 */
function fakeGraph(
  opts: { sandwich?: boolean; accepted?: boolean; revised?: string } = {}
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
      catalogs: { diagnosis: { byIcd: () => undefined } },
      llm: { for: vi.fn() },
    } as unknown as GraphAppContext["runtime"],
    async planCase(input: PlanCaseInput) {
      planCalls.push(input);
      const outline = input.revise
        ? OUTLINE.map((s, i) =>
            i === 2 ? { ...s, text: opts.revised ?? "Revised." } : s
          )
        : OUTLINE;
      return {
        diagnosis: input.diagnosis,
        userInstructions: input.userInstructions,
        basisFragments: [],
        outlineSegments: outline,
        outlineAccepted: opts.accepted ?? true,
      };
    },
    async renderCase(input: RenderCaseInput) {
      renderCalls.push(input);
      return { patient: { name: "Jane", age: 58, sex: "male" } };
    },
    translateOutline: sandwich
      ? async (values: Record<string, string>, direction: "out" | "in") => {
          translateCalls.push({ values, direction });
          return Object.fromEntries(
            Object.entries(values).map(([k, v]) => [
              k,
              direction === "out" ? `DE:${v}` : `EN:${v.replace(/^DE:/, "")}`,
            ])
          );
        }
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

function build(
  fake: Fake,
  extra: {
    records?: JobRecordRepo;
    maxReviewRounds?: number;
    now?: () => number;
    secretBox?: ReturnType<typeof createSecretBox>;
  } = {}
) {
  const channel = createJobEventChannel();
  const events: JobEvent[] = [];
  channel.subscribeAll((_jobId, event) => events.push(event));
  const records = extra.records ?? createInMemoryJobRecordRepo();
  const service = createCaseGenerationService(
    fake.graph,
    new EventBus(),
    channel,
    {
      jobRecords: records,
      maxReviewRounds: extra.maxReviewRounds ?? 3,
      ...(extra.now && { now: extra.now }),
      ...(extra.secretBox && { secretBox: extra.secretBox }),
    }
  );
  return { service, channel, events, records };
}

async function paused(
  result: Promise<CaseGenerationResult>
): Promise<CaseGenerationResult> {
  const r = await result;
  expect(r.status).toBe("awaiting_review");
  return r;
}

describe("plan mode — the stop at review", () => {
  it("stops after the outline, shows it translated, and holds no case", async () => {
    const fake = fakeGraph();
    const { service, events, records } = build(fake);

    const r = await paused(service.generate(request({ jobId: "j1" })));

    expect(r.review).toMatchObject({
      jobId: "j1",
      revision: 1,
      language: "German",
    });
    expect(r.review!.outline[2]).toEqual({
      fixed: false,
      text: "DE:Chest pain for two hours.",
    });
    // Fixed segments are translated for display too.
    expect(r.review!.outline[1]!.text).toBe("DE:## General");
    expect(fake.renderCalls).toHaveLength(0);
    // Observers get a payload-free marker, never the outline.
    const marker = events.find((e) => e.type === "awaiting_review");
    expect(marker?.data).toEqual({
      jobId: "j1",
      revision: 1,
      timestamp: expect.any(String),
    });
    expect(records.get("j1")?.status).toBe("awaiting_review");
    expect(service.getReview("j1")).toEqual(r.review);
  });

  it("binds the outline to the request language in plan mode (sandwich off) and never translates", async () => {
    const fake = fakeGraph({ sandwich: false });
    const { service } = build(fake);

    const r = await paused(service.generate(request()));

    expect(fake.planCalls[0]!.mode).toBe("plan");
    expect(r.review!.outline).toEqual(OUTLINE);
  });

  it("normal mode never pauses, never translates the outline, and fails when the judge never accepted", async () => {
    const accepted = fakeGraph();
    const ok = await build(accepted).service.generate(
      request({ mode: "normal" })
    );
    expect(ok.status).toBe("done");
    expect(accepted.translateCalls).toHaveLength(0);
    expect(accepted.planCalls[0]!.mode).toBe("normal");

    const rejected = fakeGraph({ accepted: false });
    const failed = await build(rejected).service.generate(
      request({ mode: "normal" })
    );
    expect(failed.error?.code).toBe("OUTLINE_NOT_ACCEPTED");
    expect(rejected.renderCalls).toHaveLength(0);
  });

  it("plan mode shows an outline the judge never accepted, unmarked", async () => {
    const r = await paused(
      build(fakeGraph({ accepted: false })).service.generate(request())
    );
    expect(r.review).not.toHaveProperty("verdict");
  });

  it("calls onCheckpoint once the first outline is saved", async () => {
    const onCheckpoint = vi.fn();
    const { service } = build(fakeGraph());
    await service.generate(request(), { onCheckpoint });
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
  });
});

describe("plan mode — decisions", () => {
  it("approve: nothing is translated back; the original English outline is rendered", async () => {
    const fake = fakeGraph();
    const { service, records } = build(fake);
    await paused(service.generate(request({ jobId: "a" })));

    const decided = service.decide("a", {
      revision: 1,
      decision: { action: "approve" },
    });
    expect(decided.accepted).toBe(true);
    const done = await (decided as { result: Promise<CaseGenerationResult> })
      .result;

    expect(done.status).toBe("done");
    expect(
      fake.translateCalls.filter((c) => c.direction === "in")
    ).toHaveLength(0);
    expect(fake.renderCalls[0]!.outline).toContain("Chest pain for two hours.");
    expect(records.get("a")).toBeUndefined();
  });

  it("edit: only the changed segment is translated back and merged into the English original", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    const r = await paused(service.generate(request({ jobId: "e" })));

    const outline = structuredClone(r.review!.outline);
    outline[4]!.text = "DE:61, male.";
    const decided = service.decide("e", {
      revision: 1,
      decision: { action: "edit", outline },
    });
    await (decided as { result: Promise<CaseGenerationResult> }).result;

    const back = fake.translateCalls.filter((c) => c.direction === "in");
    expect(back).toEqual([
      { values: { "4": "DE:61, male." }, direction: "in" },
    ]);
    expect(fake.renderCalls[0]!.outline).toContain("EN:61, male.");
    expect(fake.renderCalls[0]!.outline).toContain("Chest pain for two hours.");
    // Headings come from the English original, never the display copy.
    expect(fake.renderCalls[0]!.outline).toContain("## General");
    expect(fake.renderCalls[0]!.outline).not.toContain("DE:## General");
  });

  it("sandwich off: the edited outline goes to generation as submitted", async () => {
    const fake = fakeGraph({ sandwich: false });
    const { service } = build(fake);
    const r = await paused(service.generate(request({ jobId: "s" })));

    const outline = structuredClone(r.review!.outline);
    outline[2]!.text = "Brustschmerz seit zwei Stunden.";
    const decided = service.decide("s", {
      revision: 1,
      decision: { action: "edit", outline },
    });
    await (decided as { result: Promise<CaseGenerationResult> }).result;

    expect(fake.renderCalls[0]!.outline).toContain(
      "Brustschmerz seit zwei Stunden."
    );
  });

  it("refuses a stale revision, a changed heading and a wrong segment count", async () => {
    const { service } = build(fakeGraph());
    const r = await paused(service.generate(request({ jobId: "x" })));

    const stale = service.decide("x", {
      revision: 7,
      decision: { action: "approve" },
    });
    expect(stale).toMatchObject({
      accepted: false,
      error: { code: "STALE_REVISION", statusCode: 409 },
    });

    const heading = structuredClone(r.review!.outline);
    heading[1]!.text = "## Something else";
    expect(
      service.decide("x", {
        revision: 1,
        decision: { action: "edit", outline: heading },
      })
    ).toMatchObject({
      accepted: false,
      error: { code: "FIXED_SEGMENT_CHANGED", statusCode: 422 },
    });

    expect(
      service.decide("x", {
        revision: 1,
        decision: { action: "edit", outline: r.review!.outline.slice(0, 3) },
      })
    ).toMatchObject({
      accepted: false,
      error: { code: "SEGMENT_COUNT_MISMATCH" },
    });

    expect(
      service.decide("unknown", {
        revision: 1,
        decision: { action: "approve" },
      })
    ).toMatchObject({ accepted: false, error: { code: "NOT_FOUND" } });
  });

  it("revise: feedback is translated in, the plan graph revises the outline, and a new revision is issued", async () => {
    const fake = fakeGraph();
    const { service } = build(fake);
    await paused(service.generate(request({ jobId: "r" })));

    const decided = service.decide("r", {
      revision: 1,
      decision: { action: "revise", feedback: ["Mehr Ablenker"] },
    });
    const next = await paused(
      (decided as { result: Promise<CaseGenerationResult> }).result
    );

    expect(fake.planCalls[1]!.revise).toMatchObject({
      feedback: ["EN:Mehr Ablenker"],
      outlineSegments: OUTLINE,
    });
    expect(fake.planCalls[1]!.callerSuppliedFreeText).toBe(false);
    expect(next.review!.revision).toBe(2);
    expect(next.review!.outline[2]!.text).toBe("DE:Revised.");
  });

  it("refuses a revision once the rounds are used up", async () => {
    const { service } = build(fakeGraph(), { maxReviewRounds: 0 });
    await paused(service.generate(request({ jobId: "n" })));

    expect(
      service.decide("n", {
        revision: 1,
        decision: { action: "revise", feedback: ["more"] },
      })
    ).toMatchObject({
      accepted: false,
      error: { code: "REVIEW_ROUNDS_EXHAUSTED" },
    });
  });

  it("cancel ends a paused job: the channel closes cancelled and the outcome is reported as detached", async () => {
    const { service, channel, records } = build(fakeGraph());
    await paused(service.generate(request({ jobId: "c" })));
    const detached = vi.fn();
    service.onDetachedOutcome(detached);

    expect(service.cancel("c")).toBe(true);
    expect(records.get("c")).toBeUndefined();
    expect(channel.peek("c")).toMatchObject({
      state: "terminal",
      complete: { status: "cancelled" },
    });
    expect(detached).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "c",
        error: expect.objectContaining({ code: "GENERATION_CANCELLED" }),
      })
    );
  });
});

describe("plan mode — recovery after a restart", () => {
  /** A job paused on one "process", then picked up by a fresh service. */
  async function restartWith(
    setup: (service: ReturnType<typeof build>["service"]) => Promise<void>,
    fake: Fake = fakeGraph()
  ) {
    const records = createInMemoryJobRecordRepo();
    await setup(build(fake, { records }).service);
    const after = fakeGraph();
    return { records, after, ...build(after, { records }) };
  }

  it("a paused job waits again with the exact same review", async () => {
    let before: CaseGenerationResult | undefined;
    const { service } = await restartWith(async (s) => {
      before = await s.generate(
        request({ jobId: "p", transport: "nats" } as never),
        {
          transport: "nats",
        }
      );
    });

    const [resumed] = service.resume("nats");
    expect(await resumed!.result).toMatchObject({
      status: "awaiting_review",
      review: before!.review,
    });
  });

  it("after the reviewer answered, the job goes back to review with their outline — and reuses the saved English translation when resubmitted unchanged", async () => {
    const records = createInMemoryJobRecordRepo();
    const first = fakeGraph();
    const s1 = build(first, { records }).service;
    const r = await paused(s1.generate(request({ jobId: "g" })));
    const outline = structuredClone(r.review!.outline);
    outline[2]!.text = "DE:edited";
    // Simulate the crash after checkpoint 4: apply the decision's
    // translation step, then stop before generation.
    records.update("g", {
      status: "ready_to_generate",
      data: {
        ...records.get("g")!.data,
        reviewed: outline,
        merged: OUTLINE.map((s, i) =>
          i === 2 ? { ...s, text: "EN:edited" } : s
        ),
      },
    });

    const after = fakeGraph();
    const { service } = build(after, { records });
    const [resumed] = service.resume("rest");
    const review = (await resumed!.result).review!;
    expect(review.revision).toBe(2);
    expect(review.outline[2]!.text).toBe("DE:edited");

    const decided = service.decide("g", {
      revision: 2,
      decision: { action: "approve" },
    });
    await (decided as { result: Promise<CaseGenerationResult> }).result;
    expect(after.translateCalls).toHaveLength(0);
    expect(after.renderCalls[0]!.outline).toContain("EN:edited");
  });

  it("a revision interrupted by the crash comes back as a review with the feedback prefilled", async () => {
    const records = createInMemoryJobRecordRepo();
    const s1 = build(fakeGraph(), { records }).service;
    await paused(s1.generate(request({ jobId: "v" })));
    records.update("v", {
      status: "revising",
      data: { ...records.get("v")!.data, pendingFeedback: ["Mehr Ablenker"] },
    });

    const { service } = build(fakeGraph(), { records });
    const [resumed] = service.resume("rest");
    expect((await resumed!.result).review).toMatchObject({
      revision: 2,
      pendingFeedback: ["Mehr Ablenker"],
    });
  });

  it("an outline saved but not yet translated is translated, then waits for review", async () => {
    const records = createInMemoryJobRecordRepo();
    await paused(
      build(fakeGraph(), { records }).service.generate(request({ jobId: "o" }))
    );
    records.update("o", { status: "outline_ready" });

    const after = fakeGraph();
    const [resumed] = build(after, { records }).service.resume("rest");
    expect((await resumed!.result).status).toBe("awaiting_review");
    expect(after.translateCalls.map((c) => c.direction)).toEqual(["out"]);
  });

  it("normal mode resumes case generation for NATS, and ends REST jobs", async () => {
    const records = createInMemoryJobRecordRepo();
    for (const [jobId, transport] of [
      ["nats-job", "nats"],
      ["rest-job", "rest"],
    ] as const) {
      records.insert({
        jobId,
        transport,
        mode: "normal",
        status: "generating",
        revision: 0,
        updatedAt: 0,
        data: {
          schema: 1,
          sandwich: true,
          request: { generationFlags: ["patient"], mode: "normal" },
          language: "English",
          diagnosis: { name: "Influenza" },
          generationFlags: ["patient"],
          callerSuppliedFreeText: true,
          reviewRounds: 0,
          plan: { diagnosis: { name: "Influenza" }, basisFragments: [] },
          original: OUTLINE,
        },
      });
    }

    const after = fakeGraph();
    const { service } = build(after, { records });
    const nats = service.resume("nats");
    expect(await nats[0]!.result).toMatchObject({ status: "done" });
    expect(after.planCalls).toHaveLength(0);

    expect(service.resume("rest")).toEqual([]);
    expect(records.get("rest-job")).toBeUndefined();
  });

  it("a review past its deadline expires at resume", async () => {
    let time = 0;
    const records = createInMemoryJobRecordRepo();
    await paused(
      build(fakeGraph(), { records, now: () => time }).service.generate(
        request({ jobId: "t" })
      )
    );
    time = 25 * 60 * 60 * 1000;

    const [resumed] = build(fakeGraph(), {
      records,
      now: () => time,
    }).service.resume("rest");
    expect((await resumed!.result).error?.code).toBe("REVIEW_EXPIRED");
    expect(records.get("t")).toBeUndefined();
  });
});

describe("per-request API keys at rest", () => {
  it("are stored encrypted and decrypted for the next segment", async () => {
    const box = createSecretBox(Buffer.alloc(32, 7).toString("base64"));
    const fake = fakeGraph();
    const { service, records } = build(fake, { secretBox: box });

    await paused(
      service.generate(
        request({
          jobId: "k",
          llmConfig: {
            provider: "openai",
            model: "gpt",
            apiKey: "sk-secret",
            outputFormat: "json",
          },
        })
      )
    );

    const record = records.get("k")!;
    expect(JSON.stringify(record.data)).not.toContain("sk-secret");
    expect(box.open(record.encryptedApiKey!)).toBe("sk-secret");
  });
});
