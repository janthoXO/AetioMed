import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSymptomMapping } from "./repo.js";

const map = (element: unknown[]) => ({ group: [{ element }] });

describe("parseSymptomMapping", () => {
  it("minimal file", () => {
    expect(
      parseSymptomMapping(
        map([{ code: "1A40", target: [{ display: "Diarrhea" }] }])
      )
    ).toEqual({ "1A40": [{ name: "Diarrhea" }] });
  });

  it("comment becomes description", () => {
    expect(
      parseSymptomMapping(
        map([{ code: "X", target: [{ display: "Fever", comment: "high" }] }])
      )
    ).toEqual({ X: [{ name: "Fever", description: "high" }] });
  });

  it("skips unmatched, disjoint and display-less targets", () => {
    expect(
      parseSymptomMapping(
        map([
          {
            code: "X",
            target: [
              { display: "A", equivalence: "unmatched" },
              { display: "B", equivalence: "disjoint" },
              { display: "C", equivalence: "relatedto" },
              {},
            ],
          },
        ])
      )
    ).toEqual({ X: [{ name: "C" }] });
  });

  it("concatenates the same code across ConceptMaps in a Bundle", () => {
    const cm = (display: string) => ({
      resourceType: "ConceptMap",
      ...map([{ code: "X", target: [{ display }] }]),
    });
    expect(
      parseSymptomMapping({
        resourceType: "Bundle",
        entry: [
          { resource: cm("A") },
          { resource: { resourceType: "Patient" } },
          { resource: cm("B") },
        ],
      })
    ).toEqual({ X: [{ name: "A" }, { name: "B" }] });
  });

  it("empty input is empty", () => {
    expect(parseSymptomMapping({})).toEqual({});
    expect(parseSymptomMapping(null)).toEqual({});
  });

  it("parses the shipped example", () => {
    const example = JSON.parse(
      fs.readFileSync("data/examples/symptoms.fhir.json", "utf-8")
    );
    expect(parseSymptomMapping(example)).toEqual({
      "5A10": [{ name: "Polyuria" }],
    });
  });
});
