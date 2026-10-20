import { describe, expect, it } from "vitest";
import { z } from "zod";
import { envGroup } from "./env.js";

const Group = z.object({ A_URL: z.url(), A_RELEASE: z.string() });

describe("envGroup", () => {
  it("none set, or all empty, is off", () => {
    expect(envGroup(Group, {})).toBeUndefined();
    expect(envGroup(Group, { A_URL: "", A_RELEASE: "" })).toBeUndefined();
  });

  it("partly set throws, naming the missing variable", () => {
    expect(() => envGroup(Group, { A_URL: "http://a" })).toThrow(/A_RELEASE/);
  });

  it("all set parses, ignoring foreign variables", () => {
    expect(
      envGroup(Group, { A_URL: "http://a", A_RELEASE: "1", OTHER: "x" })
    ).toEqual({ A_URL: "http://a", A_RELEASE: "1" });
  });
});
