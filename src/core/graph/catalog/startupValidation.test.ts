// Pure tests over the issue 09 §1 additions to startupValidation.ts —
// `findMissingLanguages`/`formatMissingLanguages`/`warnUnconfiguredLanguages`
// operate on plain `CatalogueSpec[]` data (see `validation.test.ts` for the
// same pattern applied to the pre-existing unknown-key checks), plus one
// end-to-end test of `validateCatalogsOrExit` itself with a mocked repo
// layer and `predefinedList.js`.
import { describe, expect, it, vi, beforeEach } from "vitest";

const declared = new Map<string, Record<string, Record<string, string>>>();

vi.mock("@/core/graph/persistence/predefinedList.js", () => ({
  readDeclaredTranslations: (file: string) => declared.get(file) ?? {},
}));

import {
  findMissingLanguages,
  formatMissingLanguages,
  warnUnconfiguredLanguages,
  validateCatalogsOrExit,
  type CatalogueSpec,
} from "@/core/graph/catalog/startupValidation.js";
import type { Repos } from "@/core/graph/repos.js";

describe("findMissingLanguages", () => {
  it("reports a catalogue with no entries at all for a configured language", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: {},
        enforceUnknownKeys: true,
      },
    ];

    expect(findMissingLanguages(specs, ["English", "German"])).toEqual([
      { catalogue: "procedures", file: "procedures.yml", language: "German" },
    ]);
  });

  it("reports a catalogue whose language key is present but empty", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "labels",
        file: "labelTranslations.yml",
        baseKeys: ["Generating patient"],
        translations: { German: {} },
        enforceUnknownKeys: true,
      },
    ];

    expect(findMissingLanguages(specs, ["English", "German"])).toEqual([
      {
        catalogue: "labels",
        file: "labelTranslations.yml",
        language: "German",
      },
    ]);
  });

  it("never flags English itself", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: {},
        enforceUnknownKeys: true,
      },
    ];

    expect(findMissingLanguages(specs, ["English"])).toEqual([]);
  });

  it("does not exempt diagnosis from the completeness check", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "diagnosis",
        file: "diagnosisTranslations.yml",
        baseKeys: ["Influenza"],
        translations: {},
        enforceUnknownKeys: false,
      },
    ];

    expect(findMissingLanguages(specs, ["English", "German"])).toEqual([
      {
        catalogue: "diagnosis",
        file: "diagnosisTranslations.yml",
        language: "German",
      },
    ]);
  });

  it("passes when every configured language has at least one entry", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: { German: { "Blood Test": "Bluttest" } },
        enforceUnknownKeys: true,
      },
    ];

    expect(findMissingLanguages(specs, ["English", "German"])).toEqual([]);
  });
});

describe("formatMissingLanguages", () => {
  it("groups by catalogue and names every missing language", () => {
    const text = formatMissingLanguages([
      { catalogue: "procedures", file: "procedures.yml", language: "German" },
      { catalogue: "procedures", file: "procedures.yml", language: "French" },
    ]);

    expect(text).toContain("[procedures] procedures.yml");
    expect(text).toContain("German");
    expect(text).toContain("French");
  });
});

describe("warnUnconfiguredLanguages", () => {
  it("warns for a language present in translations but not configured", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: { German: { "Blood Test": "Bluttest" }, Spanish: {} },
        enforceUnknownKeys: true,
      },
    ];

    warnUnconfiguredLanguages(specs, ["English", "German"]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Spanish"));
    warnSpy.mockRestore();
  });

  it("does not warn when every declared language is configured", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: { German: { "Blood Test": "Bluttest" } },
        enforceUnknownKeys: true,
      },
    ];

    warnUnconfiguredLanguages(specs, ["English", "German"]);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

function fakeRepos(): Repos {
  return {
    db: {} as unknown as Repos["db"],
    procedures: {
      translationsFile: "procedures.yml",
      getEffectiveProcedureList: () => ["Blood Test"],
    } as unknown as Repos["procedures"],
    anamnesis: {
      translationsFile: "anamnesisCategoriesTranslations.yml",
      getEffectiveCategoryList: () => ["Symptoms"],
    } as unknown as Repos["anamnesis"],
    diagnosis: {
      translationsFile: "diagnosisTranslations.yml",
      getAllDiagnoses: () => [
        { name: "Influenza", icd: "1E32", alternativeNames: [] },
      ],
    } as unknown as Repos["diagnosis"],
    labels: {
      translationsFile: "labelTranslations.yml",
    } as unknown as Repos["labels"],
    symptoms: {} as unknown as Repos["symptoms"],
  };
}

describe("validateCatalogsOrExit — end to end", () => {
  beforeEach(() => {
    declared.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("exits non-zero and names the catalogue when a configured language has no translations", () => {
    // procedures.yml has no German entries at all; every other file does.
    declared.set("anamnesisCategoriesTranslations.yml", {
      German: { Symptoms: "Symptome" },
    });
    declared.set("diagnosisTranslations.yml", {
      German: { Influenza: "Grippe" },
    });
    declared.set("labelTranslations.yml", { German: {} }); // also missing

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error");

    validateCatalogsOrExit(fakeRepos(), ["English", "German"]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorOutput).toContain("procedures.yml");
    expect(errorOutput).toContain("labelTranslations.yml");

    exitSpy.mockRestore();
  });

  it("does not exit when every catalogue has entries for every configured language", () => {
    for (const file of [
      "procedures.yml",
      "anamnesisCategoriesTranslations.yml",
      "diagnosisTranslations.yml",
      "labelTranslations.yml",
    ]) {
      declared.set(file, { German: { x: "y" } });
    }
    // Give each catalogue's own base key a translation so the unknown-key
    // check also passes (irrelevant to this test, but keeps it honest).
    declared.set("procedures.yml", { German: { "Blood Test": "Bluttest" } });
    declared.set("anamnesisCategoriesTranslations.yml", {
      German: { Symptoms: "Symptome" },
    });
    declared.set("diagnosisTranslations.yml", {
      German: { Influenza: "Grippe" },
    });
    declared.set("labelTranslations.yml", { German: {} });
    // labels has no `getKnownLabels()` entries in this unit test (nothing
    // built a graph in-process), so its base key set is empty and the
    // completeness check would still flag an empty German map — give it one.
    declared.set("labelTranslations.yml", { German: { unused: "unused" } });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    validateCatalogsOrExit(fakeRepos(), ["English", "German"]);

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
