// `createProceduresRepo` over a real temp DB + catalogDir: tree round-trips
// through the `predefined_item` row, and an empty/missing catalogue means freeform.
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbHandle } from "@/adapters/persistence/db.js";
import { createProceduresRepo, PROCEDURES_FILE } from "./repo.js";

let dbHandle: DbHandle;
let tmpRoot: string;
let catalogDir: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aetiomed-procedures-repo-"));
  catalogDir = path.join(tmpRoot, "catalog");
  fs.mkdirSync(catalogDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  dbHandle?.close();
  fs.rmSync(path.join(catalogDir, PROCEDURES_FILE), { force: true });
});

function freshDb(): DbHandle {
  const cacheDir = fs.mkdtempSync(path.join(tmpRoot, "cache-"));
  dbHandle = createDb(cacheDir);
  return dbHandle;
}

const catalogue = (json: unknown) =>
  fs.writeFileSync(
    path.join(catalogDir, PROCEDURES_FILE),
    JSON.stringify(json)
  );

describe("createProceduresRepo — tree round-trip", () => {
  it("round-trips a nested tree with codes and bands through the DB row", () => {
    catalogue({
      resourceType: "Bundle",
      entry: [
        {
          resource: {
            resourceType: "CodeSystem",
            url: "s",
            concept: [
              {
                code: "cardio",
                display: "Cardiology",
                concept: [
                  { code: "ecg", display: "Resting ECG" },
                  {
                    code: "echo",
                    display: "Echo",
                    concept: [{ code: "tte", display: "Transthoracic" }],
                  },
                ],
              },
              { code: "bp", display: "Blood pressure" },
            ],
          },
        },
        {
          resource: {
            resourceType: "ObservationDefinition",
            code: { coding: [{ system: "s", code: "bp" }] },
            qualifiedInterval: [
              { range: { high: { value: 140, unit: "mm[Hg]" } } },
            ],
          },
        },
      ],
    });

    const repo = createProceduresRepo(freshDb(), catalogDir);
    expect(repo.getProcedureTree()).toEqual({
      procedures: [
        {
          name: "Blood pressure",
          code: "bp",
          bands: [{ high: 140, unit: "mm[Hg]" }],
        },
      ],
      categories: [
        {
          name: "Cardiology",
          procedures: [{ name: "Resting ECG", code: "ecg" }],
          categories: [
            {
              name: "Echo",
              procedures: [{ name: "Transthoracic", code: "tte" }],
              categories: [],
            },
          ],
        },
      ],
    });
  });

  it("an empty Bundle (no concepts) is undefined (freeform)", () => {
    catalogue({ resourceType: "Bundle", entry: [] });

    const repo = createProceduresRepo(freshDb(), catalogDir);
    expect(repo.getProcedureTree()).toBeUndefined();
  });

  it("a missing catalogue is undefined (freeform)", () => {
    const repo = createProceduresRepo(freshDb(), catalogDir);
    expect(repo.getProcedureTree()).toBeUndefined();
  });
});
