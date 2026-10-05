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
  it("chunks 20 questions into 8/8/4 and merges the answers", async () => {
    systemOne.mockImplementation(async (req) => ({
      answers: Object.fromEntries(
        Object.keys(req.questions).map((k) => [k, { noul: Number(k) / 1000 }])
      ),
    }));
    const questions = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [String(i), `q${i}?`])
    );
    const port = createSystemOnePort({ url: "http://x", model: "m" });
    const out = await port.noul("state", questions);

    expect(
      systemOne.mock.calls.map(([r]) => Object.keys(r.questions).length)
    ).toEqual([8, 8, 4]);
    expect(Object.keys(out)).toHaveLength(20);
    expect(out["19"]).toBe(0.019);
  });
});
