// #143 — `POST /api/cases` as a stream: content negotiation on the same
// route, `event: accepted` written before any node runs (so the jobId is
// never learned too late to subscribe), a heartbeat independent of label
// cadence, body-level `jobId` (the `?jobId=` query param is gone), and a
// duplicate jobId answered with a 409 on either path without starting a
// second generation. Real wiring, over real HTTP (`127.0.0.1:0`, global
// `fetch`, no supertest) — the same pattern as `labels.router.test.ts`.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestApp } from "../index.js";
import { createReadModel } from "@/core/readModel.js";
import { EventBus } from "@/core/event-bus.js";
import {
  createJobEventChannel,
  createLocalJobDirectory,
  type JobDirectory,
  type JobEventChannel,
} from "@/core/jobEvents/index.js";
import { wireLabels } from "@/core/jobEvents/labels.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import {
  createCaseGenerationService,
  type CaseGenerationService,
} from "@/core/caseGenerationService.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { getRequestContext } from "@/core/graph/utils/context.js";
import { AppError } from "@/core/graph/errors/AppError.js";
import { CaseGenerationResponseSchema } from "@/api/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { Case } from "@/core/graph/models/Case.js";
import { planAndRenderFrom } from "@/testing/graphFakes.js";
import type { GenerateCaseFn } from "@/core/graph/appContext.js";

// Same shape as `caseGenerationService.test.ts`'s `fakeGraph`, plus
// `MAX_CONTENT_PART_BYTES` (read by `encodeCase` on the success path) and a
// `graphs` stub — `GET /api/graph` is not exercised here, so
// `getGraphAsync` is never called.
function fakeGraph(generateCase: GenerateCaseFn): GraphAppContext {
  return {
    config: {
      llm: { provider: "ollama", model: "test-model" },
      allowedLlms: undefined,
      PROCEDURE_PRESELECTION: false,
      LANGUAGES: ["English", "German"],
      LANGUAGE_AUTO_DETECT: false,
      LANGUAGE_DETECT_LLM_FALLBACK: false,
      MAX_CONTENT_PART_BYTES: 5_000_000,
    } as GraphAppContext["config"],
    runtime: {
      catalogs: {
        diagnosis: { byIcd: () => undefined },
        anamnesis: { list: () => undefined },
      },
      llm: { for: vi.fn() },
    } as unknown as GraphAppContext["runtime"],
    ...planAndRenderFrom(generateCase),
    graphs: {
      plan: { getGraphAsync: async () => ({ nodes: {}, edges: [] }) },
      case: { getGraphAsync: async () => ({ nodes: {}, edges: [] }) },
    } as unknown as GraphAppContext["graphs"],
  } as GraphAppContext;
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * A `generateCase` gated per jobId (read off `getRequestContext()`, the
 * same ALS the real service binds before invoking it): each job's gate
 * opens independently via `release(jobId)`, honours `signal` abort (rejects
 * with an `AbortError`, mirroring the real graph), and — once released —
 * runs one node wrapped by `createTraceNode(bus)` so labels flow, before
 * resolving with a minimal case.
 */
function makeGatedGenerateCase(bus: EventBus) {
  const gates = new Map<
    string,
    { promise: Promise<void>; release: () => void }
  >();
  const signals = new Map<string, AbortSignal | undefined>();
  const traceNode = createTraceNode(bus);
  const doThing = traceNode(
    "some_node",
    async () => ({ ok: true }),
    "Doing a thing"
  );

  function gateFor(jobId: string) {
    let gate = gates.get(jobId);
    if (!gate) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => (release = resolve));
      gate = { promise, release };
      gates.set(jobId, gate);
    }
    return gate;
  }

  const generateCase = vi.fn(async () => {
    const ctx = getRequestContext();
    const jobId = ctx!.jobId!;
    const signal = ctx?.signal;
    signals.set(jobId, signal);
    const gate = gateFor(jobId);

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort);
      gate.promise.then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });

    await doThing();
    // A full `Patient` (not just `{ name, age, sex }` as in the other
    // harnesses' fixtures) — this result is encoded through the real
    // `CaseWireSchema`/`PatientSchema` on the success path here, unlike
    // `caseGenerationService.test.ts`'s and `labels.router.test.ts`'s
    // harnesses, which never encode their fixture and so tolerate a partial
    // one.
    return {
      patient: {
        name: "Jane",
        age: 40,
        height: 165,
        weight: 60,
        gender: "female",
      },
    } as Case;
  }) as unknown as GenerateCaseFn;

  return {
    generateCase,
    release: (jobId: string) => gateFor(jobId).release(),
    signalWasAborted: (jobId: string) => signals.get(jobId)?.aborted === true,
  };
}

function createHarness(opts: { maxConcurrent?: number } = {}) {
  const bus = new EventBus();
  const channel: JobEventChannel = createJobEventChannel();
  wireLabels(bus, channel, new InMemoryLabelCatalog());
  const { generateCase, release, signalWasAborted } =
    makeGatedGenerateCase(bus);
  const graph = fakeGraph(generateCase);
  const service = createCaseGenerationService(graph, bus, channel, {
    ...(opts.maxConcurrent !== undefined && {
      maxConcurrent: opts.maxConcurrent,
    }),
  });
  return {
    bus,
    channel,
    graph,
    service,
    generateCase,
    release,
    signalWasAborted,
  };
}

async function startApp(
  graph: GraphAppContext,
  service: CaseGenerationService,
  jobEvents: JobEventChannel,
  directory?: JobDirectory
): Promise<{ server: Server; port: number }> {
  const app = createRestApp({
    graph,
    service,
    jobEvents,
    directory: directory ?? createLocalJobDirectory(jobEvents, service.cancel),
    features: new Set(["REST"]),
    readModel: createReadModel(graph, new Set(["REST"])),
    heartbeatMs: 40,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

function requestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    diagnosis: "Influenza",
    generationFlags: ["patient"],
    ...overrides,
  });
}

/**
 * A plan-mode request. `language: "English"` with `TRANSLATION_SANDWICH`
 * unset in `fakeGraph`'s config (falsy) means `translatesOutline` is false
 * (#159), so the review outline is exactly `planAndRenderFrom`'s planned
 * outline: `["", "## Plan options", JSON.stringify(opts)]`.
 */
function planRequestBody(overrides: Record<string, unknown> = {}): string {
  return requestBody({ mode: "plan", language: "English", ...overrides });
}

/**
 * Read from `reader` (accumulating across calls, via a per-reader buffer)
 * until `predicate(text)` is true, or reject after `timeoutMs`. Copied from
 * `labels.router.test.ts`.
 */
const buffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, string>();

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 2000
): Promise<string> {
  const decoder = new TextDecoder();
  let text = buffers.get(reader) ?? "";
  const deadline = Date.now() + timeoutMs;

  while (!predicate(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      buffers.set(reader, text);
      throw new Error(
        `readUntil timed out after ${timeoutMs}ms; got: ${JSON.stringify(text)}`
      );
    }

    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("readUntil: read timed out")),
          remaining
        )
      ),
    ]);

    if (result.value) text += decoder.decode(result.value, { stream: true });
    buffers.set(reader, text);

    if (result.done) break;
  }

  if (!predicate(text)) {
    throw new Error(
      `stream ended before predicate matched; got: ${JSON.stringify(text)}`
    );
  }
  return text;
}

/** Parse the `data:` line of the first `event: <type>` frame in `text`. */
function extractEventData(text: string, type: string): unknown {
  const marker = `event: ${type}\ndata: `;
  const idx = text.indexOf(marker);
  if (idx === -1) {
    throw new Error(`event: ${type} not found in ${JSON.stringify(text)}`);
  }
  const start = idx + marker.length;
  const end = text.indexOf("\n", start);
  return JSON.parse(text.slice(start, end === -1 ? text.length : end));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("POST /api/cases (#143) — content negotiation, streaming, heartbeat", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("accepted before any node event: event: accepted precedes event: label precedes event: result", async () => {
    const { channel, service, graph, release } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "job-sse-1" }),
    });
    const reader = res.body!.getReader();

    const beforeRelease = await readUntil(reader, (t) =>
      t.includes("event: accepted")
    );
    expect(beforeRelease).toContain('"jobId":"job-sse-1"');
    expect(beforeRelease).not.toContain("event: label");

    release("job-sse-1");

    const afterResult = await readUntil(reader, (t) =>
      t.includes("event: result")
    );
    const idxAccepted = afterResult.indexOf("event: accepted");
    const idxLabel = afterResult.indexOf("event: label");
    const idxResult = afterResult.indexOf("event: result");
    expect(idxAccepted).toBeGreaterThanOrEqual(0);
    expect(idxLabel).toBeGreaterThan(idxAccepted);
    expect(idxResult).toBeGreaterThan(idxLabel);

    const data = extractEventData(afterResult, "result") as {
      jobId: string;
      language: string;
      patient: { name: string };
    };
    expect(data.jobId).toBe("job-sse-1");
    expect(data.language).toBeDefined();
    expect(data.patient.name).toBe("Jane");

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("server mints a jobId when omitted", async () => {
    const { channel, service, graph, release } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody(),
    });
    const reader = res.body!.getReader();

    const text = await readUntil(reader, (t) => t.includes("event: accepted"));
    const data = extractEventData(text, "accepted") as { jobId: string };
    expect(data.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    release(data.jobId);
    await readUntil(reader, (t) => t.includes("event: result"));
  });

  it("heartbeat with no label activity: at least two ping frames, no label", async () => {
    const { channel, service, graph, release } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "job-heartbeat" }),
    });
    const reader = res.body!.getReader();

    await readUntil(reader, (t) => t.includes("event: accepted"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const text = await readUntil(
      reader,
      (t) => (t.match(/: ping/g) ?? []).length >= 2,
      500
    );
    expect((text.match(/: ping/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain("event: label");

    release("job-heartbeat");
    await readUntil(reader, (t) => t.includes("event: result"));
  });

  it("error frame: a thrown AppError becomes event: error", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireLabels(bus, channel, new InMemoryLabelCatalog());
    const generateCase = vi.fn(async () => {
      throw new AppError("boom", "GENERATION_FAILED", 500);
    }) as unknown as GenerateCaseFn;
    const graph = fakeGraph(generateCase);
    const service = createCaseGenerationService(graph, bus, channel);
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "job-error" }),
    });
    const reader = res.body!.getReader();

    const text = await readUntil(reader, (t) => t.includes("event: error"));
    const data = extractEventData(text, "error") as {
      error: { code: string };
    };
    expect(data.error.code).toBe("GENERATION_FAILED");

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("a result that fails to encode still ends the stream with event: error, not silently", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireLabels(bus, channel, new InMemoryLabelCatalog());
    // Schema-invalid on the wire (`PatientSchema` needs height/weight/
    // gender), so encoding the success body throws after the headers are
    // sent — the same shape as a content part over MAX_CONTENT_PART_BYTES.
    const generateCase = vi.fn(async () => ({
      patient: { name: "Jane" },
    })) as unknown as GenerateCaseFn;
    const graph = fakeGraph(generateCase);
    const service = createCaseGenerationService(graph, bus, channel);
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "job-encode-fail" }),
    });
    const reader = res.body!.getReader();

    const text = await readUntil(reader, (t) => t.includes("event: error"));
    expect(text).not.toContain("event: result");
    const data = extractEventData(text, "error") as {
      error: { code: string };
    };
    expect(data.error.code).toBe("GENERATION_FAILED");
    const { done } = await reader.read();
    expect(done).toBe(true);
    consoleError.mockRestore();
  });

  it("duplicate jobId does not start a second generation — 409 on both Accept paths", async () => {
    const { channel, service, graph, release, generateCase } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const firstRes = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "dup" }),
    });
    const reader1 = firstRes.body!.getReader();
    await readUntil(reader1, (t) => t.includes("event: accepted"));

    const jsonRes = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: requestBody({ jobId: "dup" }),
    });
    expect(jsonRes.status).toBe(409);
    const jsonBody = (await jsonRes.json()) as { error: { code: string } };
    expect(jsonBody.error.code).toBe("JOB_ALREADY_ACTIVE");

    const sseRes = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "dup" }),
    });
    expect(sseRes.status).toBe(409);
    const sseBody = (await sseRes.json()) as { error: { code: string } };
    expect(sseBody.error.code).toBe("JOB_ALREADY_ACTIVE");

    expect(generateCase).toHaveBeenCalledTimes(1);

    release("dup");
    await readUntil(reader1, (t) => t.includes("event: result"));
  });

  it("Accept: application/json keeps today's response shape", async () => {
    const { channel, service, graph, release } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const resultPromise = fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: requestBody({ jobId: "job-json-1" }),
    });
    release("job-json-1");
    const res = await resultPromise;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const body = await res.json();
    const parsed = CaseGenerationResponseSchema.parse(body);
    expect(parsed).toHaveProperty("jobId");
    expect(parsed).toHaveProperty("language");
  });

  it("no Accept header returns the same JSON as Accept: application/json", async () => {
    const { channel, service, graph, release } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const resultPromise = fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody({ jobId: "job-json-2" }),
    });
    release("job-json-2");
    const res = await resultPromise;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("client disconnect still cancels — SSE path", async () => {
    const { channel, service, graph, generateCase, signalWasAborted } =
      createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;
    const completes: Record<string, unknown> = {};
    channel.subscribeAll((jobId, e) => {
      if (e.type === "complete") completes[jobId] = e.data;
    });

    const controller = new AbortController();
    const jobId = "job-disconnect-sse";
    const fetchPromise = fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId }),
      signal: controller.signal,
    });

    const res = await fetchPromise;
    const reader = res.body!.getReader();
    await readUntil(reader, (t) => t.includes("event: accepted"));

    controller.abort();
    await reader.cancel().catch(() => {});

    await waitUntil(() => channel.state(jobId) !== "active");
    expect(completes[jobId]).toMatchObject({ status: "cancelled" });
    expect(generateCase).toHaveBeenCalledTimes(1);
    expect(signalWasAborted(jobId)).toBe(true);
  });

  it("client disconnect still cancels — application/json path", async () => {
    const { channel, service, graph, generateCase, signalWasAborted } =
      createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;
    const completes: Record<string, unknown> = {};
    channel.subscribeAll((jobId, e) => {
      if (e.type === "complete") completes[jobId] = e.data;
    });

    const controller = new AbortController();
    const jobId = "job-disconnect-json";
    const fetchPromise = fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: requestBody({ jobId }),
      signal: controller.signal,
    });
    fetchPromise.catch(() => {});

    await waitUntil(() => channel.state(jobId) === "active");
    controller.abort();

    await waitUntil(() => channel.state(jobId) !== "active");
    expect(completes[jobId]).toMatchObject({ status: "cancelled" });
    expect(generateCase).toHaveBeenCalledTimes(1);
    expect(signalWasAborted(jobId)).toBe(true);
  });

  it("?jobId= is gone — the query param no longer supplies the jobId", async () => {
    const { channel, service, graph, release } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases?jobId=abc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody(),
    });
    const reader = res.body!.getReader();

    const text = await readUntil(reader, (t) => t.includes("event: accepted"));
    const data = extractEventData(text, "accepted") as { jobId: string };
    expect(data.jobId).not.toBe("abc");

    release(data.jobId);
    await readUntil(reader, (t) => t.includes("event: result"));
  });

  it("invalid body jobId is a 400", async () => {
    const { channel, service, graph } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody({ jobId: "a.b" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST_BODY");
  });

  it("queued behind MAX_CONCURRENT_GENERATIONS: accepted + heartbeat while queued, no label until the first finishes", async () => {
    const { channel, service, graph, release } = createHarness({
      maxConcurrent: 1,
    });
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const firstRes = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "job-queue-1" }),
    });
    const reader1 = firstRes.body!.getReader();
    await readUntil(reader1, (t) => t.includes("event: accepted"));

    const secondRes = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "job-queue-2" }),
    });
    const reader2 = secondRes.body!.getReader();

    const acceptedText = await readUntil(reader2, (t) =>
      t.includes("event: accepted")
    );
    expect(acceptedText).toContain('"jobId":"job-queue-2"');

    const heartbeatText = await readUntil(
      reader2,
      (t) => (t.match(/: ping/g) ?? []).length >= 1
    );
    expect(heartbeatText).not.toContain("event: label");

    release("job-queue-1");
    release("job-queue-2");

    await readUntil(reader1, (t) => t.includes("event: result"));
    await readUntil(reader2, (t) => t.includes("event: result"));
  });
});

type Plan = { fixed: boolean; text: string }[];

describe("plan mode (#159) — a stateless call stops at its plan", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("a plan-mode POST stops at 'planned' — 200 with the plan, JSON path", async () => {
    const { channel, service, graph } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: planRequestBody({ jobId: "job-plan-1" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobId: string;
      mode: string;
      language: string;
      plan: Plan;
    };
    expect(body.jobId).toBe("job-plan-1");
    expect(body.mode).toBe("plan");
    // planAndRenderFrom's planned outline (#159): three segments, the
    // middle one fixed.
    expect(body.plan).toHaveLength(3);
    expect(body.plan[1]).toMatchObject({
      fixed: true,
      text: "## Plan options",
    });
  });

  it("SSE create in plan mode: event: accepted precedes event: plan, then the stream ends with no event: result", async () => {
    const { channel, service, graph } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: planRequestBody({ jobId: "job-plan-sse" }),
    });
    const reader = res.body!.getReader();

    const text = await readUntil(reader, (t) => t.includes("event: plan"));
    const idxAccepted = text.indexOf("event: accepted");
    const idxPlan = text.indexOf("event: plan");
    expect(idxAccepted).toBeGreaterThanOrEqual(0);
    expect(idxPlan).toBeGreaterThan(idxAccepted);

    const data = extractEventData(text, "plan") as {
      jobId: string;
      mode: string;
      plan: Plan;
    };
    expect(data.jobId).toBe("job-plan-sse");
    expect(data.mode).toBe("plan");

    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(text).not.toContain("event: result");
  });

  it("normal mode SSE emits event: plan before event: result", async () => {
    const { channel, service, graph, release } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: requestBody({ jobId: "job-normal-plan" }),
    });
    const reader = res.body!.getReader();

    const beforeRelease = await readUntil(reader, (t) =>
      t.includes("event: plan")
    );
    expect(beforeRelease).not.toContain("event: result");

    release("job-normal-plan");

    const text = await readUntil(reader, (t) => t.includes("event: result"));
    const idxPlan = text.indexOf("event: plan");
    const idxResult = text.indexOf("event: result");
    expect(idxPlan).toBeGreaterThanOrEqual(0);
    expect(idxResult).toBeGreaterThan(idxPlan);

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("a malformed plan shape (not alternating editable/fixed) is a 400", async () => {
    const { channel, service, graph } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: planRequestBody({
        jobId: "job-plan-malformed",
        plan: [
          { fixed: true, text: "## General" },
          { fixed: true, text: "## Patient" },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST_BODY");
  });

  it("the same jobId can be posted again after a 'planned' stop — no 409", async () => {
    const { channel, service, graph } = createHarness();
    ({ server } = await startApp(graph, service, channel));
    const port = (server.address() as AddressInfo).port;

    await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: planRequestBody({ jobId: "job-plan-reuse" }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: planRequestBody({ jobId: "job-plan-reuse" }),
    });

    expect(res.status).not.toBe(409);
  });
});

/** A `JobDirectory` whose `cancel` is fully scripted — `watch` is never
 * exercised by these tests. */
function stubDirectory(cancel: JobDirectory["cancel"]): JobDirectory {
  return {
    watch: () => Promise.reject(new Error("not used by these tests")),
    cancel,
  };
}

describe("DELETE /api/cases/:jobId (#145) — via the JobDirectory port", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('directory.cancel() → "cancelled" is a 204', async () => {
    const { channel, service, graph } = createHarness();
    const directory = stubDirectory(async () => "cancelled");
    ({ server } = await startApp(graph, service, channel, directory));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases/job-x`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it('directory.cancel() → "finished" is a 404 mentioning "already finished"', async () => {
    const { channel, service, graph } = createHarness();
    const directory = stubDirectory(async () => "finished");
    ({ server } = await startApp(graph, service, channel, directory));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases/job-x`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("already finished");
  });

  it('directory.cancel() → "unknown" is a 404', async () => {
    const { channel, service, graph } = createHarness();
    const directory = stubDirectory(async () => "unknown");
    ({ server } = await startApp(graph, service, channel, directory));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases/job-x`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("directory.cancel() rejecting (backbone timeout) is a 504", async () => {
    const { channel, service, graph } = createHarness();
    const directory = stubDirectory(async () => {
      throw new Error("no reply in time");
    });
    ({ server } = await startApp(graph, service, channel, directory));
    const port = (server.address() as AddressInfo).port;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await fetch(`http://127.0.0.1:${port}/api/cases/job-x`, {
      method: "DELETE",
    });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_TIMEOUT");
    consoleError.mockRestore();
  });
});
