// Proves the fix for the first NATS defect from issue 05: the handler used
// to destructure five fields off the parsed request and never forward
// `difficulty` to `generateCase`. Now the handler forwards the whole parsed
// request (including `difficulty`) straight to `CaseGenerationService`, so
// asserting on the service call is enough — there is no longer a
// hand-picked field list that can silently drop one.
import { describe, it, expect, vi } from "vitest";
import type { JsMsg } from "@nats-io/jetstream";
import { consumeCaseGenerateMessage } from "./cases.handler.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type {
  CaseGenerationService,
  CaseGenerationResult,
} from "@/core/caseGenerationService.js";

vi.mock("./cases.publisher.js", () => ({
  publishCaseGenerationResponse: vi.fn().mockResolvedValue(undefined),
}));

function fakeMsg(payload: unknown): JsMsg {
  return {
    json: () => payload,
    ack: vi.fn(),
    nak: vi.fn(),
  } as unknown as JsMsg;
}

function fakeGraph(): GraphAppContext {
  return {
    config: {
      llm: {
        provider: "ollama",
        model: "test-model",
        temperature: 0.7,
      },
      allowedLlms: undefined,
      LLM_SMALL: false,
    },
    runtime: {} as GraphAppContext["runtime"],
    generateCase: vi.fn(),
  } as unknown as GraphAppContext;
}

describe("NATS cases handler", () => {
  it("forwards difficulty: 'hard' through to CaseGenerationService.generate", async () => {
    const generate = vi.fn(
      async (): Promise<CaseGenerationResult> => ({
        jobId: "job-1",
        status: "done",
        case: {},
      })
    );
    const service: CaseGenerationService = { generate, cancel: vi.fn() };

    const msg = fakeMsg({
      jobId: "job-1",
      diagnosis: "Influenza",
      difficulty: "hard",
    });

    await consumeCaseGenerateMessage(msg, fakeGraph(), service);

    expect(generate).toHaveBeenCalledTimes(1);
    const [call] = generate.mock.calls;
    expect(call?.[0]).toMatchObject({
      jobId: "job-1",
      diagnosis: "Influenza",
      difficulty: "hard",
    });
  });
});
