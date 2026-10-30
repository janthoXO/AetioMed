import { describe, expect, it } from "vitest";
import { parseFhirCatalogue } from "./fhir.js";
import { nodeKey } from "@/core/graph/shared/domain/ProcedureTree.js";

const SYSTEM = "https://example.org/procedures";

const bundle = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id: "ignored" } },
    {
      resource: {
        resourceType: "CodeSystem",
        content: "supplement",
        supplements: "http://unitsofmeasure.org",
        concept: [{ code: "mg/dL", display: "mg/dl" }],
      },
    },
    {
      resource: {
        resourceType: "CodeSystem",
        url: SYSTEM,
        status: "active",
        content: "complete",
        concept: [
          {
            code: "lab",
            display: "Laboratory",
            designation: [{ language: "de-DE", value: "Labor" }],
            property: [{ code: "notSelectable", valueBoolean: true }],
            concept: [
              {
                code: "lab.crp",
                display: "CRP",
                designation: [{ language: "de", value: "CRP (de)" }],
              },
              { code: "lab.hb", display: "Hemoglobin" },
            ],
          },
          { code: "ecg", display: "Resting ECG" },
          {
            code: "old",
            display: "Retired",
            property: [{ code: "status", valueCode: "retired" }],
          },
          {
            code: "heading",
            display: "Empty heading",
            property: [{ code: "notSelectable", valueBoolean: true }],
          },
        ],
      },
    },
    {
      resource: {
        resourceType: "ObservationDefinition",
        code: {
          coding: [
            { system: "http://loinc.org", code: "718-7" },
            { system: SYSTEM, code: "lab.hb" },
          ],
        },
        qualifiedInterval: [
          {
            category: "reference",
            gender: "female",
            age: { low: { value: 18, code: "a" } },
            range: {
              low: { value: 12, unit: "g/dL" },
              high: { value: 16, unit: "g/dL" },
            },
          },
          {
            category: "critical",
            range: { low: { value: 7, unit: "g/dL" } },
          },
          {
            age: {
              low: { value: 26, code: "wk" },
              high: { value: 8766, code: "h" },
            },
            range: { low: { value: 10, unit: "g/dL" } },
          },
        ],
      },
    },
  ],
};

describe("parseFhirCatalogue", () => {
  it("builds the tree, translations and reference bands", () => {
    const { tree, translations } = parseFhirCatalogue(bundle);
    expect(tree).toEqual({
      procedures: [{ name: "Resting ECG", code: "ecg" }],
      categories: [
        {
          name: "Laboratory",
          categories: [],
          procedures: [
            { name: "CRP", code: "lab.crp" },
            {
              name: "Hemoglobin",
              code: "lab.hb",
              bands: [
                {
                  low: 12,
                  high: 16,
                  unit: "g/dL",
                  gender: "female",
                  age: { low: 18 },
                },
                {
                  low: 10,
                  unit: "g/dL",
                  age: { low: 26 * (7 / 365.25), high: 1 },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(translations).toEqual({
      de: {
        [nodeKey(["Laboratory"])]: "Labor",
        [nodeKey(["Laboratory", "CRP"])]: "CRP (de)",
      },
    });
  });

  it("takes the English name from a designation when the CodeSystem is not English", () => {
    const { tree, translations } = parseFhirCatalogue({
      resourceType: "Bundle",
      entry: [
        {
          resource: {
            resourceType: "CodeSystem",
            language: "de",
            concept: [
              {
                code: "ekg",
                display: "Ruhe-EKG",
                designation: [{ language: "en", value: "Resting ECG" }],
              },
            ],
          },
        },
      ],
    });
    expect(tree.procedures).toEqual([{ name: "Resting ECG", code: "ekg" }]);
    expect(translations).toEqual({
      de: { [nodeKey(["Resting ECG"])]: "Ruhe-EKG" },
    });
  });

  it("an empty file is an empty catalogue", () => {
    expect(parseFhirCatalogue({}).tree).toEqual({
      categories: [],
      procedures: [],
    });
  });

  it("rejects a non-Bundle and an age in a non-time unit", () => {
    expect(() => parseFhirCatalogue({ resourceType: "CodeSystem" })).toThrow();
    expect(() =>
      parseFhirCatalogue({
        resourceType: "Bundle",
        entry: [
          {
            resource: {
              resourceType: "ObservationDefinition",
              code: { coding: [{ code: "x" }] },
              qualifiedInterval: [
                {
                  age: { low: { value: 1, unit: "years" } },
                  range: { low: { value: 1 } },
                },
              ],
            },
          },
        ],
      })
    ).toThrow(/FHIR age unit/);
  });
});
