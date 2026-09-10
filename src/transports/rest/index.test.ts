// #140 — app-level coverage for `createRestApp`: the always-on `GET
// /api/graph` and `GET /api/cases/:jobId/labels` routes are actually
// mounted, the old traces-over-SSE route is gone, and `GET /api/features`
// still reports the raw flag set — all with no OTel env configured, since
// neither gate applies here any more.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRestApp } from "./index.js";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { CaseGenerationService } from "@/core/caseGenerationService.js";
import type { CompiledCaseGraph } from "@/core/graph/02graphs/caseGraph.js";

// Same shape as `caseGenerationService.test.ts`'s `fakeGraph`.
function fakeGraph(): GraphAppContext {
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
    generateCase: vi.fn(),
    caseGraph: {
      getGraphAsync: async () => ({
        nodes: { __start__: {}, a: {}, b: {}, __end__: {} },
        edges: [
          { source: "__start__", target: "a" },
          { source: "a", target: "b" },
          { source: "b", target: "__end__" },
        ],
      }),
    } as unknown as CompiledCaseGraph,
  } as GraphAppContext;
}

describe("createRestApp (#140) — app-level route table", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      "OTEL_SDK_DISABLED",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_SERVICE_NAME",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function startApp(): Promise<{ server: Server; port: number }> {
    const app = createRestApp({
      graph: fakeGraph(),
      service: {
        generate: vi.fn(),
        cancel: vi.fn(),
      } as unknown as CaseGenerationService,
      jobEvents: createJobEventChannel(),
      features: new Set(["REST"]),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return { server, port };
  }

  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("GET /api/graph returns the compiled topology, synthetic start/end filtered", async () => {
    ({ server } = await startApp());
    const port = (server!.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: { id: string }[];
      edges: { source: string; target: string }[];
    };

    expect(body.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(body.edges).toEqual([{ source: "a", target: "b" }]);
  });

  it("GET /api/cases/unknown/labels streams SSE and ends with event: complete", async () => {
    ({ server } = await startApp());
    const port = (server!.address() as AddressInfo).port;

    const res = await fetch(
      `http://127.0.0.1:${port}/api/cases/unknown/labels`
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);

    const text = await res.text();
    expect(text).toContain("event: complete");
  });

  it("GET /api/traces/x/stream is gone (404) — the old SSE trace route", async () => {
    ({ server } = await startApp());
    const port = (server!.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/traces/x/stream`);
    expect(res.status).toBe(404);
  });

  it("GET /api/features reports the raw flag set", async () => {
    ({ server } = await startApp());
    const port = (server!.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/features`);
    expect(await res.json()).toEqual(["REST"]);
  });
});
