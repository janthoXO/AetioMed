// Pure tests over `findMissingLanguages`/`formatMissingLanguages`/
// `warnUnconfiguredLanguages` on plain `CatalogueSpec[]`, plus one end-to-end
// `validateCatalogsOrExit` test with mocked repo layer and `predefinedList.js`.
import { describe, expect, it, vi, beforeEach } from "vitest";

const declared = new Map<string, Record<string, Record<string, string>>>();

vi.mock("@/adapters/persistence/predefinedList.js", () => ({
  readDeclaredTranslations: (file: string) => declared.get(file) ?? {},
}));

import {
  findMissingLanguages,
  formatMissingLanguages,
  warnUnconfiguredLanguages,
  validateCatalogsOrExit,
  type CatalogueSpec,
} from "@/adapters/catalog/startupValidation.js";
import { nodeKey } from "@/core/graph/shared/domain/ProcedureTree.js";
import type { Repos } from "@/adapters/repos.js";

describe("findMissingLanguages", () => {
  it("reports a catalogue that declares other languages but not a configured one", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: { French: { "Blood Test": "Analyse de sang" } },
        enforceUnknownKeys: true,
      },
    ];

    expect(findMissingLanguages(specs, ["en", "de"])).toEqual([
      { catalogue: "procedures", file: "procedures.yml", language: "de" },
    ]);
  });

  it("does not report a catalogue whose file declares no language (missing or empty)", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: {},
        enforceUnknownKeys: true,
      },
    ];

    expect(findMissingLanguages(specs, ["en", "de"])).toEqual([]);
  });

  it("reports a catalogue whose language key is present but empty", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "labels",
        file: "labelTranslations.yml",
        baseKeys: ["Generating patient"],
        translations: { de: {} },
        enforceUnknownKeys: true,
      },
    ];

    expect(findMissingLanguages(specs, ["en", "de"])).toEqual([
      {
        catalogue: "labels",
        file: "labelTranslations.yml",
        language: "de",
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

    expect(findMissingLanguages(specs, ["en"])).toEqual([]);
  });

  it("does not exempt diagnosis from the completeness check", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "diagnosis",
        file: "diagnosisTranslations.yml",
        baseKeys: ["Influenza"],
        translations: { French: { Influenza: "Grippe" } },
        enforceUnknownKeys: false,
      },
    ];

    expect(findMissingLanguages(specs, ["en", "de"])).toEqual([
      {
        catalogue: "diagnosis",
        file: "diagnosisTranslations.yml",
        language: "de",
      },
    ]);
  });

  it("passes when every configured language has at least one entry", () => {
    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: { de: { "Blood Test": "Bluttest" } },
        enforceUnknownKeys: true,
      },
    ];

    expect(findMissingLanguages(specs, ["en", "de"])).toEqual([]);
  });
});

describe("formatMissingLanguages", () => {
  it("groups by catalogue and names every missing language", () => {
    const text = formatMissingLanguages([
      { catalogue: "procedures", file: "procedures.yml", language: "de" },
      { catalogue: "procedures", file: "procedures.yml", language: "French" },
    ]);

    expect(text).toContain("[procedures] procedures.yml");
    expect(text).toContain("de");
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
        translations: { de: { "Blood Test": "Bluttest" }, es: {} },
        enforceUnknownKeys: true,
      },
    ];

    warnUnconfiguredLanguages(specs, ["en", "de"], { icd: false });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("es"));
    warnSpy.mockRestore();
  });

  it("does not warn when every declared language is configured", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const specs: CatalogueSpec[] = [
      {
        catalogue: "procedures",
        file: "procedures.yml",
        baseKeys: ["Blood Test"],
        translations: { de: { "Blood Test": "Bluttest" } },
        enforceUnknownKeys: true,
      },
    ];

    warnUnconfiguredLanguages(specs, ["en", "de"], { icd: false });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

function fakeRepos(
  procedureTree: {
    categories: {
      name: string;
      categories: never[];
      procedures: { name: string }[];
    }[];
    procedures: { name: string }[];
  } = { categories: [], procedures: [{ name: "Blood Test" }] }
): Repos {
  return {
    db: {} as unknown as Repos["db"],
    procedures: {
      translationsFile: "procedures.yml",
      getProcedureTree: () => procedureTree,
    } as unknown as Repos["procedures"],
    anamnesis: {
      translationsFile: "anamnesisCategoriesTranslations.yml",
      getEffectiveCategoryList: () => ["Symptoms"],
    } as unknown as Repos["anamnesis"],
    diagnosis: {
      translationsFile: "diagnosisTranslations.yml",
    } as unknown as Repos["diagnosis"],
    labels: {
      translationsFile: "labelTranslations.yml",
    } as unknown as Repos["labels"],
    outlineHeadings: {
      translationsFile: "outlineHeadingsTranslations.yml",
    } as unknown as Repos["outlineHeadings"],
    symptoms: {} as unknown as Repos["symptoms"],
  };
}

describe("validateCatalogsOrExit — end to end", () => {
  beforeEach(() => {
    declared.clear();
    declared.set("outlineHeadingsTranslations.yml", {
      de: { General: "Allgemein" },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("exits non-zero and names the catalogue when a configured language has no translations", () => {
    // procedures.yml declares French but not German; every other file has German.
    declared.set("procedures.yml", {
      French: { [nodeKey(["Blood Test"])]: "Analyse de sang" },
    });
    declared.set("anamnesisCategoriesTranslations.yml", {
      de: { Symptoms: "Symptome" },
    });
    declared.set("diagnosisTranslations.yml", {
      de: { Influenza: "Grippe" },
    });
    declared.set("labelTranslations.yml", { de: {} }); // also missing

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error");

    validateCatalogsOrExit(fakeRepos(), ["en", "de"], { icd: false });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorOutput).toContain("procedures.yml");
    expect(errorOutput).toContain("labelTranslations.yml");

    exitSpy.mockRestore();
  });

  it("does not exit when every translations file is missing", () => {
    declared.clear();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    validateCatalogsOrExit(fakeRepos(), ["en", "de"], { icd: false });

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("does not exit when every catalogue has entries for every configured language", () => {
    for (const file of [
      "procedures.yml",
      "anamnesisCategoriesTranslations.yml",
      "diagnosisTranslations.yml",
      "labelTranslations.yml",
    ]) {
      declared.set(file, { de: { x: "y" } });
    }
    // Give each catalogue's own base key a translation so the unknown-key
    // check also passes (irrelevant to this test, but keeps it honest).
    declared.set("procedures.yml", {
      de: { [nodeKey(["Blood Test"])]: "Bluttest" },
    });
    declared.set("anamnesisCategoriesTranslations.yml", {
      de: { Symptoms: "Symptome" },
    });
    declared.set("diagnosisTranslations.yml", {
      de: { Influenza: "Grippe" },
    });
    declared.set("labelTranslations.yml", { de: {} });
    // labels has no `getKnownLabels()` entries in this unit test (nothing
    // built a graph in-process), so its base key set is empty and the
    // completeness check would still flag an empty German map — give it one.
    declared.set("labelTranslations.yml", { de: { unused: "unused" } });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    validateCatalogsOrExit(fakeRepos(), ["en", "de"], { icd: false });

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("without ICD, diagnosis base keys are the translations file's own English keys", () => {
    declared.set("diagnosisTranslations.yml", {
      de: { Influenza: "Grippe" },
      fr: { Influenza: "Grippe", Cholera: "Choléra" },
    });
    const log = vi.spyOn(console, "log").mockClear();
    validateCatalogsOrExit(fakeRepos(), ["en"], { icd: false });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/diagnosis\s+2 entries/);
  });

  it("with ICD, skips the diagnosis catalogue and warns when the file has entries", () => {
    declared.set("diagnosisTranslations.yml", { de: { Influenza: "Grippe" } });
    const log = vi.spyOn(console, "log").mockClear();
    const warn = vi.spyOn(console, "warn").mockClear();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    // German is configured but absent elsewhere; only diagnosis' absence of check matters here.
    validateCatalogsOrExit(fakeRepos(), ["en"], { icd: true });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toContain("diagnosis ");
    expect(warn).toHaveBeenCalledWith(
      "[catalog] diagnosisTranslations.yml is ignored: ICD is configured, diagnosis names come from ICD."
    );
    exitSpy.mockRestore();
  });

  const nestedTree = {
    categories: [
      {
        name: "Cardiology",
        categories: [],
        procedures: [{ name: "Resting ECG" }],
      },
    ],
    procedures: [],
  };

  it("exits non-zero when a translation path is not in the English tree, naming it readably", () => {
    declared.set("procedures.yml", {
      de: { [nodeKey(["Cardiology", "Resting EKG"])]: "Ruhe-EKG" },
    });
    declared.set("anamnesisCategoriesTranslations.yml", {
      de: { Symptoms: "Symptome" },
    });
    declared.set("diagnosisTranslations.yml", {
      de: { Influenza: "Grippe" },
    });
    declared.set("labelTranslations.yml", { de: { unused: "unused" } });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error");

    validateCatalogsOrExit(fakeRepos(nestedTree), ["en", "de"], { icd: false });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorOutput).toContain("Cardiology › Resting EKG");
    expect(errorOutput).toContain("Cardiology › Resting ECG"); // Levenshtein suggestion

    exitSpy.mockRestore();
  });

  it("does not exit for a valid nested translation", () => {
    declared.set("procedures.yml", {
      de: {
        [nodeKey(["Cardiology"])]: "Kardiologie",
        [nodeKey(["Cardiology", "Resting ECG"])]: "Ruhe-EKG",
      },
    });
    declared.set("anamnesisCategoriesTranslations.yml", {
      de: { Symptoms: "Symptome" },
    });
    declared.set("diagnosisTranslations.yml", {
      de: { Influenza: "Grippe" },
    });
    declared.set("labelTranslations.yml", { de: { unused: "unused" } });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    validateCatalogsOrExit(fakeRepos(nestedTree), ["en", "de"], { icd: false });

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("exits non-zero when the catalogue has duplicate sibling names", () => {
    const duplicateTree = {
      categories: [
        { name: "Echo", categories: [], procedures: [{ name: "x" }] },
      ],
      procedures: [{ name: "Echo" }],
    };
    declared.set("procedures.yml", { de: {} });
    declared.set("anamnesisCategoriesTranslations.yml", {
      de: { Symptoms: "Symptome" },
    });
    declared.set("diagnosisTranslations.yml", {
      de: { Influenza: "Grippe" },
    });
    declared.set("labelTranslations.yml", { de: { unused: "unused" } });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error");

    validateCatalogsOrExit(fakeRepos(duplicateTree), ["en", "de"], {
      icd: false,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errorOutput).toContain("Echo");

    exitSpy.mockRestore();
  });
});
