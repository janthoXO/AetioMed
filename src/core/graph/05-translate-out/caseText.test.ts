// Covers the pure path/apply helpers of the "rest" pass (`caseTextMap`/`applyCaseTextTranslations`/
// `translateProcedureTree`). Map has one key per part (`.alt`); `value` is never translated; see `caseText.ts`.
import { describe, expect, it } from "vitest";
import {
  caseTextMap,
  applyCaseTextTranslations,
  translateProcedureTree,
} from "./caseText.js";
import {
  encodeText,
  type ContentPart,
} from "@/core/graph/shared/domain/ContentPart.js";
import { nodeKey } from "@/core/graph/shared/domain/ProcedureTree.js";
import type { Case } from "@/core/graph/shared/domain/Case.js";

/** Local fixture builder: text part whose `value` is the encoded `alt`. */
function fixtureTextPart(alt: string): ContentPart {
  return { type: "text/plain", value: encodeText(alt), alt };
}

const mixedCase: Case = {
  chiefComplaint: [fixtureTextPart("Cough for three days.")],
  anamnesis: [
    {
      category: "History",
      answer: [fixtureTextPart("First."), fixtureTextPart("Second.")],
    },
  ],
  procedures: {
    procedures: [],
    categories: [
      {
        name: "Cardiology",
        categories: [],
        procedures: [
          {
            name: "Chest X-ray",
            order: 0,
            relevance: "obligatory",
            result: [
              fixtureTextPart("Infiltrate noted."),
              {
                type: "image/png",
                alt: "PA chest radiograph, right lower lobe consolidation.",
                value: new Uint8Array(200).fill(137),
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("caseTextMap — path/order keying, including procedures", () => {
  it("keys every part's alt only (no .text keys), by stable position — never by name", () => {
    const map = caseTextMap(mixedCase);

    expect(map).toEqual({
      "chiefComplaint.0.alt": "Cough for three days.",
      "anamnesis.0.answer.0.alt": "First.",
      "anamnesis.0.answer.1.alt": "Second.",
      "procedures.0.result.0.alt": "Infiltrate noted.",
      "procedures.0.result.1.alt":
        "PA chest radiograph, right lower lobe consolidation.",
    });
    // Never keyed on the procedure name — that is the defined pass's job,
    // and keying on it here would couple the two disjoint passes.
    expect(Object.keys(map).some((k) => k.includes("Chest X-ray"))).toBe(false);
    expect(Object.keys(map).some((k) => k.endsWith(".text"))).toBe(false);
  });
});

describe("applyCaseTextTranslations — chiefComplaint/anamnesis only", () => {
  it("a multi-part field survives with its part count and order intact", () => {
    const translated = applyCaseTextTranslations(mixedCase, {
      "anamnesis.0.answer.0.alt": "Premier (étiquette).",
      "anamnesis.0.answer.1.alt": "Deuxième (étiquette).",
    });

    expect(translated.anamnesis?.[0]?.answer).toHaveLength(2);
    expect(translated.anamnesis?.[0]?.answer.map((p) => p.alt)).toEqual([
      "Premier (étiquette).",
      "Deuxième (étiquette).",
    ]);
    expect(
      translated.anamnesis?.[0]?.answer.map((p) =>
        new TextDecoder().decode(p.value)
      )
    ).toEqual(["First.", "Second."]);
  });

  it("translates only alt; a text/plain part keeps its original value bytes", () => {
    const translated = applyCaseTextTranslations(mixedCase, {
      "chiefComplaint.0.alt": "Plainte principale (traduite).",
    });

    const part = translated.chiefComplaint![0]!;
    expect(part.type).toBe("text/plain");
    expect(part.alt).toBe("Plainte principale (traduite).");
    expect(part.value).toEqual(mixedCase.chiefComplaint![0]!.value);
    expect(new TextDecoder().decode(part.value)).toBe("Cough for three days.");
  });

  it("a missing key falls back to the original alt/value, untouched", () => {
    const translated = applyCaseTextTranslations(mixedCase, {});
    expect(translated.chiefComplaint).toEqual(mixedCase.chiefComplaint);
  });

  it("leaves anamnesis[].category untouched — disjoint from the defined pass by construction", () => {
    const translated = applyCaseTextTranslations(mixedCase, {});
    expect(translated.anamnesis?.[0]?.category).toBe("History");
  });
});

describe("translateProcedureTree — node names and result parts in one walk", () => {
  it("translates category and leaf names from the defined map, and result parts from the rest map", () => {
    const translated = translateProcedureTree(
      mixedCase.procedures!,
      {
        [nodeKey(["Cardiology"])]: "Kardiologie",
        [nodeKey(["Cardiology", "Chest X-ray"])]: "Röntgen-Thorax",
      },
      {
        "procedures.0.result.0.alt": "Infiltrat notiert.",
        "procedures.0.result.1.alt": "Röntgenbild Thorax.",
      }
    );

    expect(translated.categories[0]!.name).toBe("Kardiologie");
    const leaf = translated.categories[0]!.procedures[0]!;
    expect(leaf.name).toBe("Röntgen-Thorax");
    expect(leaf.order).toBe(0);
    expect(leaf.relevance).toBe("obligatory");
    expect(leaf.result[0]!.alt).toBe("Infiltrat notiert.");
    // Text part: value byte-identical too, only alt translated.
    expect(new TextDecoder().decode(leaf.result[0]!.value)).toBe(
      "Infiltrate noted."
    );
    // Non-text part: same rule.
    expect(leaf.result[1]!.alt).toBe("Röntgenbild Thorax.");
    expect(leaf.result[1]!.value).toBe(
      mixedCase.procedures!.categories[0]!.procedures[0]!.result[1]!.value
    );
  });

  it("a miss in either map falls back to the original English value", () => {
    const translated = translateProcedureTree(mixedCase.procedures!, {}, {});
    expect(translated.categories[0]!.name).toBe("Cardiology");
    expect(translated.categories[0]!.procedures[0]!.name).toBe("Chest X-ray");
    expect(translated.categories[0]!.procedures[0]!.result).toEqual(
      mixedCase.procedures!.categories[0]!.procedures[0]!.result
    );
  });
});
