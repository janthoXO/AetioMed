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
  it("chunks 130 questions into 64/64/2, merges answers, forwards max_len", async () => {
    systemOne.mockImplementation(async (req) => ({
      answers: Object.fromEntries(
        Object.keys(req.questions).map((k) => [k, { noul: Number(k) / 1000 }])
      ),
    }));
    const questions = Object.fromEntries(
      Array.from({ length: 130 }, (_, i) => [String(i), `q${i}?`])
    );
    const port = createSystemOnePort({
      url: "http://x",
      model: "m",
      maxLen: 7,
    });
    const out = await port.noul("state", questions);

    expect(
      systemOne.mock.calls.map(([r]) => Object.keys(r.questions).length)
    ).toEqual([64, 64, 2]);
    expect(systemOne.mock.calls.every(([r]) => r.max_len === 7)).toBe(true);
    expect(Object.keys(out)).toHaveLength(130);
    expect(out["129"]).toBe(0.129);
  });
});
