import { describe, expect, it } from "vitest";
import z from "zod";
import { keyedTranslationSchema } from "./translate.js";

describe("keyedTranslationSchema", () => {
  const keys = ["chiefComplaint.0.alt", "Family History"];
  const schema = keyedTranslationSchema(keys);

  it("emits no propertyNames (vLLM/xgrammar rejects it) and requires every key", () => {
    const json = JSON.stringify(z.toJSONSchema(schema));
    expect(json).not.toContain("propertyNames");
    expect(z.toJSONSchema(schema).required).toEqual(keys);
  });

  it("fails on a missing key, strips extras", () => {
    expect(schema.safeParse({ [keys[0]!]: "x" }).success).toBe(false);
    expect(
      schema.parse({ [keys[0]!]: "a", [keys[1]!]: "b", extra: "c" })
    ).toEqual({ [keys[0]!]: "a", [keys[1]!]: "b" });
  });
});
