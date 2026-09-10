// Small #142 coverage: a jobId arriving via `?jobId=` is validated the same
// way a NATS-supplied one is (it's a subject token too), and is threaded
// through to `CaseGenerationService.generate` unchanged.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestApp } from "../index.js";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type {
  CaseGenerationService,
  CaseGenerationResult,
} from "@/core/caseGenerationService.js";

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
    } as unknown as GraphAppContext["runtime"],
    generateCase: vi.fn(),
  } as GraphAppContext;
}

async function startApp(
  generate: CaseGenerationService["generate"]
): Promise<{ server: Server; port: number }> {
  const app = createRestApp({
    graph: fakeGraph(),
    service: {
      generate,
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

describe("POST /api/cases — ?jobId= validation (#142)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("rejects a jobId containing '.' with 400", async () => {
    const generate = vi.fn();
    ({ server } = await startApp(generate));
    const port = (server!.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/cases?jobId=a.b`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diagnosis: "Influenza" }),
    });

    expect(res.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it("passes a valid ?jobId= through to service.generate", async () => {
    const generate = vi.fn(
      async (): Promise<CaseGenerationResult> => ({
        jobId: "abc",
        status: "failed",
        error: {
          code: "GENERATION_FAILED",
          message: "stub",
          statusCode: 500,
        },
      })
    );
    ({ server } = await startApp(generate));
    const port = (server!.address() as AddressInfo).port;

    await fetch(`http://127.0.0.1:${port}/api/cases?jobId=abc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diagnosis: "Influenza" }),
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ jobId: "abc" });
  });
});
