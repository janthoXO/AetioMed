import { describe, expect, it } from "vitest";
import { instruction, roll, rubric, type Recipe } from "./recipe.js";

/** mulberry32: small seeded PRNG, so the distribution check is deterministic. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const diagnosis = { name: "NSTEMI" };

describe("roll", () => {
  it("matches the #212 tables within sampling error", () => {
    const random = seeded(42);
    const n = 20_000;
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const [label] = roll("hard", random);
      const key = label ? `${label.source}/${label.class}` : "none";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const share = (key: string) => (counts[key] ?? 0) / n;
    expect(share("none")).toBeCloseTo(0.25, 1);
    expect(share("referral/wrong")).toBeCloseTo(0.4 * 0.3, 1);
    expect(share("patient/correct")).toBeCloseTo(0.35 * 0.25, 1);
  });

  it("never rolls a wrong label at easy", () => {
    const random = seeded(7);
    for (let i = 0; i < 5_000; i++) {
      expect(roll("easy", random)[0]?.class).not.toBe("wrong");
    }
  });

  it("gives a partial label exactly one partial type; a patient only lay ones", () => {
    const random = seeded(3);
    for (let i = 0; i < 2_000; i++) {
      const [label] = roll("medium", random);
      expect(label?.partialType !== undefined).toBe(label?.class === "partial");
      if (label?.source === "patient" && label.partialType) {
        expect(["too_broad", "same_organ"]).toContain(label.partialType);
      }
    }
  });
});

describe("instruction and rubric", () => {
  const recipes: Record<string, Recipe> = {
    none: [],
    correct: [{ source: "referral", class: "correct" }],
    partial: [{ source: "referral", class: "partial", partialType: "finding" }],
    wrong: [{ source: "referral", class: "wrong" }],
  };

  it("names the true diagnosis as label text only for a correct label", () => {
    expect(instruction(recipes.correct!, diagnosis)).toContain('"NSTEMI"');
    for (const key of ["none", "partial", "wrong"]) {
      expect(instruction(recipes[key]!, diagnosis)).not.toContain('"NSTEMI"');
    }
  });

  it("puts the label where its source says and states its relation", () => {
    expect(instruction(recipes.correct!, diagnosis)).toContain(
      "Chief complaint"
    );
    expect(instruction(recipes.none!, diagnosis)).toContain(
      "No diagnostic label"
    );
    expect(
      instruction([{ source: "patient", class: "wrong" }], diagnosis)
    ).toContain("Anamnesis");
    expect(instruction(recipes.partial!, diagnosis)).toContain(
      "missing its cause"
    );
    expect(rubric(recipes.wrong!, diagnosis)).toContain("look-alike");
    expect(rubric(recipes.none!, diagnosis)).toContain("No diagnostic label");
  });
});
