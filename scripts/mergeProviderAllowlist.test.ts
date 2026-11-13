import { describe, expect, it } from "vitest";
import { mergeAllowlist, parseAllowlistCsv } from "./mergeProviderAllowlist.js";

const mk = () => ({
  entry: [
    {
      resource: {
        resourceType: "CodeSystem",
        property: [{ code: "panel", type: "boolean" }],
        concept: [
          {
            code: "cat",
            concept: [
              { code: "a" },
              {
                code: "b",
                property: [{ code: "modalityProvider", valueCode: "stale" }],
              },
            ],
          },
        ],
      },
    },
  ],
});
const cs = (b: ReturnType<typeof mk>) => b.entry[0]!.resource as any;

describe("mergeAllowlist", () => {
  it("parses csv", () => {
    expect(
      parseAllowlistCsv("code,provider\n# c\n\n a , ecg \na,text\n")
    ).toEqual([
      ["a", "ecg"],
      ["a", "text"],
    ]);
  });

  it("adds properties and declaration, strips stale, is idempotent", () => {
    const pairs = parseAllowlistCsv("a,ecg\na,text\na,ecg");
    const { bundle, errors } = mergeAllowlist(mk(), pairs);
    expect(errors).toEqual([]);
    const [a, b] = cs(bundle as any).concept[0].concept;
    expect(a.property).toEqual([
      { code: "modalityProvider", valueCode: "ecg" },
      { code: "modalityProvider", valueCode: "text" },
    ]);
    expect(b.property).toBeUndefined();
    expect(
      cs(bundle as any).property.filter(
        (p: any) => p.code === "modalityProvider"
      )
    ).toHaveLength(1);
    const once = JSON.stringify(bundle);
    expect(JSON.stringify(mergeAllowlist(JSON.parse(once), pairs).bundle)).toBe(
      once
    );
  });

  it("errors on unknown and category codes", () => {
    const { errors } = mergeAllowlist(mk(), [
      ["nope", "x"],
      ["cat", "x"],
    ]);
    expect(errors).toHaveLength(2);
    expect(errors.join()).toMatch(/cat: not a leaf/);
    expect(errors.join()).toMatch(/unknown codes: nope/);
  });
});
