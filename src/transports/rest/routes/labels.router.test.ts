// #139/#140 — end-to-end over real HTTP: `createLabelsRouter` mounted on a real
// Express app, driven with global `fetch` and a raw SSE body reader (no
// `supertest`), wired the same way the composition root wires it: a real
// `EventBus` + `createJobEventChannel()`, `wireLabels`
// producing onto it, and `CaseGenerationService` opening/closing each job's
// channel around a fake graph.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { EventBus } from "@/core/event-bus.js";
import {
  createJobEventChannel,
  createLocalJobDirectory,
  type JobDirectory,
  type JobEventChannel,
} from "@/core/jobEvents/index.js";
import { wireLabels } from "@/core/jobEvents/labels.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { createCaseGenerationService } from "@/core/caseGenerationService.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import createLabelsRouter from "./labels.router.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { Case } from "@/core/graph/models/Case.js";
import { planAndRenderFrom } from "@/testing/graphFakes.js";
import type { GenerateCaseFn } from "@/core/graph/appContext.js";

// Same shape as `caseGenerationService.test.ts`'s `fakeGraph` — a minimal
// stand-in for the composition root's real `GraphAppContext`.
function fakeGraph(generateCase: GenerateCaseFn): GraphAppContext {
  return {
    config: {
      llm: { provider: "ollama", model: "test-model" },
      allowedLlms: undefined,
      PROCEDURE_PRESELECTION: false,
      LANGUAGES: ["English", "German"],
      LANGUAGE_AUTO_DETECT: false,
      LANGUAGE_DETECT_LLM_FALLBACK: false,
    } as GraphAppContext["config"],
    runtime: {
      catalogs: {
        diagnosis: { byIcd: () => undefined },
      },
      llm: { for: vi.fn() },
    } as unknown as GraphAppContext["runtime"],
    ...planAndRenderFrom(generateCase),
  } as GraphAppContext;
}

/**
 * Read from `reader` (accumulating across calls, via a per-reader buffer)
 * until `predicate(text)` is true, or reject after `timeoutMs`.
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

/** Build a fresh bus/channel/service wired the production way, plus a gated
 * generation that runs one traced node before returning a minimal case. */
function createHarness() {
  const bus = new EventBus();
  const channel: JobEventChannel = createJobEventChannel();
  wireLabels(bus, channel, new InMemoryLabelCatalog());

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const traceNode = createTraceNode(bus);
  const doThing = traceNode(
    "some_node",
    async () => ({ ok: true }),
    "Doing a thing"
  );

  const generateCase = vi.fn(async () => {
    await gate;
    await doThing();
    return { patient: { name: "Jane", age: 40, sex: "female" } } as Case;
  });

  const service = createCaseGenerationService(
    fakeGraph(generateCase),
    bus,
    channel
  );

  return {
    channel,
    service,
    directory: createLocalJobDirectory(channel, service.cancel),
    release: () => release(),
  };
}

async function startServer(
  directory: ReturnType<typeof createLocalJobDirectory>
): Promise<{
  server: Server;
  port: number;
}> {
  const app = express();
  app.use("/api/cases", createLabelsRouter(directory));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

describe("labels.router (#139, #140) — end-to-end over real HTTP", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("streams connected and label events for a REST-submitted job — never a trace or a node output — then ends on complete", async () => {
    const { service, directory, release } = createHarness();
    ({ server } = await startServer(directory));
    const port = (server!.address() as AddressInfo).port;

    // The channel is opened synchronously by `service.generate`, before its
    // first await, so the stream can be opened right after issuing the call.
    const p = service.generate({
      diagnosis: "Influenza",
      generationFlags: ["patient"],
      jobId: "job-e2e",
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/api/cases/job-e2e/labels`
    );
    const reader = res.body!.getReader();

    await readUntil(reader, (text) => text.includes("event: connected"));

    release();
    await p;

    const text = await readUntil(reader, (text) =>
      text.includes("event: complete")
    );

    expect(text).toContain("event: label");
    // Node output left the SSE channel in #140; it goes to OTel.
    expect(text).not.toContain("event: trace");
    expect(text).not.toContain('"ok":true');
    expect(text).toContain('"status":"started"');
    expect(text).toContain('"status":"completed"');

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("a plan-mode call ends with event: complete whose status is 'planned', never the plan itself (#159)", async () => {
    // A gated `planCase`, not `planAndRenderFrom` (whose plan stage never
    // awaits anything) — this test needs the stop to land *after* the
    // labels stream subscribes, or the buffered-watch race the harness
    // above exists for real generation would let it happen before any
    // listener attaches.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const graph = {
      config: {
        llm: { provider: "ollama", model: "test-model" },
        allowedLlms: undefined,
        PROCEDURE_PRESELECTION: false,
        LANGUAGES: ["English", "German"],
        LANGUAGE_AUTO_DETECT: false,
        LANGUAGE_DETECT_LLM_FALLBACK: false,
      } as GraphAppContext["config"],
      runtime: {
        catalogs: { diagnosis: { byIcd: () => undefined } },
        llm: { for: vi.fn() },
      } as unknown as GraphAppContext["runtime"],
      async planCase(opts: { diagnosis: unknown; userInstructions: unknown }) {
        await gate;
        return {
          diagnosis: opts.diagnosis,
          userInstructions: opts.userInstructions,
          basisFragments: [],
          outlineAccepted: true,
          outlineSegments: [
            { fixed: false, text: "" },
            { fixed: true, text: "## Plan options" },
            { fixed: false, text: "{}" },
          ],
        };
      },
      async renderCase() {
        return { patient: { name: "Jane", age: 40, sex: "female" } } as Case;
      },
      translateOutline: undefined,
    } as unknown as GraphAppContext;

    const channel: JobEventChannel = createJobEventChannel();
    const service = createCaseGenerationService(graph, new EventBus(), channel);
    const directory = createLocalJobDirectory(channel, service.cancel);
    ({ server } = await startServer(directory));
    const port = (server!.address() as AddressInfo).port;

    const p = service.generate({
      diagnosis: "Influenza",
      generationFlags: ["patient"],
      jobId: "job-plan-labels",
      mode: "plan",
      language: "English",
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/api/cases/job-plan-labels/labels`
    );
    const reader = res.body!.getReader();
    await readUntil(reader, (text) => text.includes("event: connected"));

    release();
    const result = await p;
    expect(result.status).toBe("planned");

    const text = await readUntil(reader, (text) =>
      text.includes("event: complete")
    );
    expect(text).toContain('"jobId":"job-plan-labels"');
    expect(text).toContain('"status":"planned"');
    // An observer never sees the plan itself — only the requester gets it,
    // as this call's own return value.
    expect(text).not.toContain("outline");
    expect(text).not.toContain("Plan options");

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("delivers every event to two independent subscribers of the same job", async () => {
    const { service, directory, release } = createHarness();
    ({ server } = await startServer(directory));
    const port = (server!.address() as AddressInfo).port;

    const p = service.generate({
      diagnosis: "Influenza",
      generationFlags: ["patient"],
      jobId: "job-e2e-2",
    });

    const res1 = await fetch(
      `http://127.0.0.1:${port}/api/cases/job-e2e-2/labels`
    );
    const res2 = await fetch(
      `http://127.0.0.1:${port}/api/cases/job-e2e-2/labels`
    );
    const reader1 = res1.body!.getReader();
    const reader2 = res2.body!.getReader();

    await readUntil(reader1, (text) => text.includes("event: connected"));
    await readUntil(reader2, (text) => text.includes("event: connected"));

    release();
    await p;

    const text1 = await readUntil(reader1, (text) =>
      text.includes("event: complete")
    );
    const text2 = await readUntil(reader2, (text) =>
      text.includes("event: complete")
    );

    const count1 = (text1.match(/event: label/g) ?? []).length;
    const count2 = (text2.match(/event: label/g) ?? []).length;

    expect(count1).toBeGreaterThanOrEqual(2);
    expect(count1).toBe(count2);
    expect(text1).toContain("event: complete");
    expect(text2).toContain("event: complete");
  });

  it("an unknown job answers 404 JSON, never an SSE stream (#145)", async () => {
    const channel = createJobEventChannel();
    const directory = createLocalJobDirectory(channel, () => false);
    ({ server } = await startServer(directory));
    const port = (server!.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases/nope/labels`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("a terminal job's stream (no live subscriber) ends with its complete event", async () => {
    const { service, directory, release } = createHarness();
    ({ server } = await startServer(directory));
    const port = (server!.address() as AddressInfo).port;

    release();
    await service.generate({
      diagnosis: "Influenza",
      generationFlags: ["patient"],
      jobId: "job-term",
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/api/cases/job-term/labels`
    );
    const reader = res.body!.getReader();

    const text = await readUntil(reader, (text) =>
      text.includes("event: complete")
    );
    expect(text).toContain('"status":"done"');
    // Watch, not collect (#145): the terminal marker never carries
    // the case.
    expect(text).not.toContain("patient");
    expect(text).not.toContain('"case"');

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("directory.watch() rejecting (backbone timeout) is a 504", async () => {
    const rejecting: JobDirectory = {
      watch: () => Promise.reject(new Error("no reply in time")),
      cancel: () => Promise.reject(new Error("not used by this test")),
    };
    const app = express();
    app.use("/api/cases", createLabelsRouter(rejecting));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server!.address() as AddressInfo).port;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await fetch(`http://127.0.0.1:${port}/api/cases/job-x/labels`);
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_TIMEOUT");
    consoleError.mockRestore();
  });
});
