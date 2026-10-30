import { describe, expect, it } from "vitest";
import { bandsFor, formatBand, type ReferenceBand } from "./Procedure.js";

const bands: ReferenceBand[] = [
  { low: 12, high: 16, unit: "g/dL", gender: "female", age: { low: 18 } },
  { low: 13, high: 17, unit: "g/dL", gender: "male", age: { low: 18 } },
  { low: 11, high: 14, unit: "g/dL", age: { high: 18 } },
];
const patient = { name: "A", height: 170, weight: 70 };

describe("bandsFor", () => {
  it("picks the band matching gender and half-open age", () => {
    expect(bandsFor(bands, { ...patient, age: 18, gender: "male" })).toEqual([
      bands[1],
    ]);
    expect(bandsFor(bands, { ...patient, age: 17, gender: "male" })).toEqual([
      bands[2],
    ]);
  });

  it("no matching band is none; an outline-text patient gets every band", () => {
    expect(
      bandsFor(bands.slice(0, 1), { ...patient, age: 40, gender: "male" })
    ).toEqual([]);
    expect(bandsFor(bands, "## Patient\n40 year old man")).toEqual(bands);
  });
});

describe("formatBand", () => {
  it("renders range, unit and context", () => {
    expect(formatBand(bands[0]!)).toBe("12–16 g/dL (female, age 18–∞ y)");
    expect(formatBand({ high: 5, unit: "mg/L" })).toBe("≤ 5 mg/L");
    expect(formatBand({ low: 1, age: { high: 1 / 12 } })).toBe(
      "≥ 1 (age 0–0.08 y)"
    );
  });
});
