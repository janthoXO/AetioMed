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
  type JobEventChannel,
} from "@/core/jobEvents/channel.js";
import { wireLabels } from "@/core/jobEvents/labels.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { createCaseGenerationService } from "@/core/caseGenerationService.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import createLabelsRouter from "./labels.router.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { Case } from "@/core/graph/models/Case.js";

// Same shape as `caseGenerationService.test.ts`'s `fakeGraph` — a minimal
// stand-in for the composition root's real `GraphAppContext`.
function fakeGraph(
  generateCase: GraphAppContext["generateCase"]
): GraphAppContext {
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
    generateCase,
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

  return { channel, service, release: () => release() };
}

async function startServer(channel: JobEventChannel): Promise<{
  server: Server;
  port: number;
}> {
  const app = express();
  app.use("/api/cases", createLabelsRouter(channel));
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
    const { channel, service, release } = createHarness();
    ({ server } = await startServer(channel));
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

  it("delivers every event to two independent subscribers of the same job", async () => {
    const { channel, service, release } = createHarness();
    ({ server } = await startServer(channel));
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

  it("an unknown job's stream ends immediately with an empty complete event", async () => {
    const channel = createJobEventChannel();
    ({ server } = await startServer(channel));
    const port = (server!.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases/nope/labels`);
    const reader = res.body!.getReader();

    const text = await readUntil(reader, (text) =>
      text.includes("event: complete")
    );
    expect(text).toContain("data: {}");

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it("a terminal job's stream (no live subscriber) ends with its complete event", async () => {
    const { channel, service, release } = createHarness();
    ({ server } = await startServer(channel));
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

    const { done } = await reader.read();
    expect(done).toBe(true);
  });
});
