import { describe, it, expect, vi } from "vitest";

const systemOne = vi.hoisted(() => vi.fn());
vi.mock("@typesafe-ai/sdk", async (orig) => ({
  ...(await orig<typeof import("@typesafe-ai/sdk")>()),
  TypeSafeClient: class {
    systemOne = systemOne;
  },
}));

import { createSystemOnePort } from "./systemOne.js";

describe("createSystemOnePort", () => {
  it("sends one choice question 'pick' over the options, forwards max_len, returns probabilities", async () => {
    systemOne.mockResolvedValue({
      answers: {
        pick: {
          type: "choice",
          choice: "b",
          confidence: 0.7,
          probabilities: { a: 0.3, b: 0.7 },
        },
      },
    });
    const port = createSystemOnePort({
      url: "http://x",
      model: "m",
      maxLen: 7,
    });
    const out = await port.choice("state", "which?", ["a", "b"]);

    const req = systemOne.mock.calls[0]![0];
    expect(Object.keys(req.questions)).toEqual(["pick"]);
    expect(req.questions.pick.type).toBe("choice");
    expect(req.questions.pick.criteria).toEqual({ a: null, b: null });
    expect(req.max_len).toBe(7);
    expect(out).toEqual({ a: 0.3, b: 0.7 });
  });
});
