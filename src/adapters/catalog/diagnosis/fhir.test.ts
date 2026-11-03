import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDiagnosisCodeSystem } from "./fhir.js";

const durchfall = { de: { Diarrhea: "Durchfall" } };

describe("parseDiagnosisCodeSystem", () => {
  it("minimal file", () => {
    expect(
      parseDiagnosisCodeSystem({
        concept: [
          {
            display: "Diarrhea",
            designation: [{ language: "de", value: "Durchfall" }],
          },
        ],
      })
    ).toEqual(durchfall);
  });

  it("German CodeSystem with an en designation", () => {
    expect(
      parseDiagnosisCodeSystem({
        language: "de-CH",
        concept: [
          {
            display: "Durchfall",
            designation: [{ language: "en", value: "Diarrhea" }],
          },
        ],
      })
    ).toEqual(durchfall);
  });

  it("flattens nested concepts", () => {
    expect(
      parseDiagnosisCodeSystem({
        concept: [
          {
            display: "Infection",
            concept: [
              {
                display: "Diarrhea",
                designation: [{ language: "de", value: "Durchfall" }],
              },
            ],
          },
        ],
      })
    ).toEqual(durchfall);
  });

  it("Bundle: ignores other resources", () => {
    expect(
      parseDiagnosisCodeSystem({
        resourceType: "Bundle",
        entry: [
          { resource: { resourceType: "Patient" } },
          {
            resource: {
              resourceType: "CodeSystem",
              concept: [
                {
                  display: "Diarrhea",
                  designation: [{ language: "de", value: "Durchfall" }],
                },
              ],
            },
          },
        ],
      })
    ).toEqual(durchfall);
  });

  it("skips a concept without an English name", () => {
    expect(
      parseDiagnosisCodeSystem({
        concept: [{ designation: [{ language: "de", value: "Durchfall" }] }],
      })
    ).toEqual({});
  });

  it("empty input is empty", () => {
    expect(parseDiagnosisCodeSystem({})).toEqual({});
    expect(parseDiagnosisCodeSystem(null)).toEqual({});
  });

  it("malformed is undefined", () => {
    expect(parseDiagnosisCodeSystem({ concept: "x" })).toBeUndefined();
  });

  it("parses the shipped example", () => {
    const example = JSON.parse(
      fs.readFileSync("data/examples/diagnoses.fhir.json", "utf-8")
    );
    expect(parseDiagnosisCodeSystem(example)).toEqual({
      de: { "Type 1 diabetes mellitus": "Diabetes mellitus Typ 1" },
    });
  });
});
