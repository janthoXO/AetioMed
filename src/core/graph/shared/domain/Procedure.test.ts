import { describe, expect, it } from "vitest";
import { bandsFor, formatBand, type ReferenceBand } from "./Procedure.js";

const bands: ReferenceBand[] = [
  { low: 12, high: 16, unit: "g/dL", gender: "female", age: { low: 18 } },
  { low: 13, high: 17, unit: "g/dL", gender: "male", age: { low: 18 } },
  { low: 11, high: 14, unit: "g/dL", age: { high: 18 } },
];
const patient = { name: "A", height: 170, weight: 70 };

describe("bandsFor", () => {
  const male = { ...patient, gender: "male" as const };
  const tiered: ReferenceBand[] = [
    { low: 4 },
    { low: 3, age: { low: 18 } },
    { low: 2, gender: "male" },
    { low: 1, gender: "male", age: { low: 18, high: 65 } },
  ];

  it("takes the first tier that has a band", () => {
    const tier = (age: number, bands = tiered) =>
      bandsFor(bands, { ...male, age })[0]?.low;
    expect(tier(40)).toBe(1); // own gender, age fits
    expect(tier(70)).toBe(2); // own gender, no age
    expect(tier(70, tiered.slice(0, 2))).toBe(3); // no gender, age fits
    expect(tier(10, tiered.slice(0, 2))).toBe(4); // no gender, no age
    expect(bandsFor([bands[0]!], { ...male, age: 40 })).toEqual([]);
  });

  it("closed age ranges: an age on a shared bound gets the lower band", () => {
    const ages: ReferenceBand[] = [
      { low: 2, age: { low: 2, high: 5 } },
      { low: 1, age: { high: 2 } },
    ];
    expect(bandsFor(ages, { ...male, age: 2 })[0]?.low).toBe(1);
    expect(bandsFor(ages, { ...male, age: 5 })[0]?.low).toBe(2);
  });

  it("an outline-text patient gets every band", () => {
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
