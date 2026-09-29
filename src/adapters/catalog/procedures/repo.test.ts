// `createProceduresRepo` over a real temp DB + catalogDir: tree round-trips
// through the `predefined_item` row, and empty/missing YAML both mean freeform.
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbHandle } from "@/adapters/persistence/db.js";
import { createProceduresRepo } from "./repo.js";

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
  fs.rmSync(path.join(catalogDir, "procedures.yml"), { force: true });
});

function freshDb(): DbHandle {
  const cacheDir = fs.mkdtempSync(path.join(tmpRoot, "cache-"));
  dbHandle = createDb(cacheDir);
  return dbHandle;
}

describe("createProceduresRepo — tree round-trip", () => {
  it("round-trips a nested tree through the DB row", () => {
    fs.writeFileSync(
      path.join(catalogDir, "procedures.yml"),
      `categories:
  - name: Cardiology
    procedures:
      - name: Resting ECG
    categories:
      - name: Echo
        procedures:
          - name: Transthoracic
procedures:
  - name: Blood pressure
`
    );

    const repo = createProceduresRepo(freshDb(), catalogDir);
    expect(repo.getProcedureTree()).toEqual({
      procedures: [{ name: "Blood pressure" }],
      categories: [
        {
          name: "Cardiology",
          procedures: [{ name: "Resting ECG" }],
          categories: [
            {
              name: "Echo",
              procedures: [{ name: "Transthoracic" }],
              categories: [],
            },
          ],
        },
      ],
    });
  });

  it("an empty tree (no leaves at all) is undefined (freeform)", () => {
    fs.writeFileSync(
      path.join(catalogDir, "procedures.yml"),
      `categories: []\nprocedures: []\n`
    );

    const repo = createProceduresRepo(freshDb(), catalogDir);
    expect(repo.getProcedureTree()).toBeUndefined();
  });

  it("a missing procedures.yml is undefined (freeform)", () => {
    const repo = createProceduresRepo(freshDb(), catalogDir);
    expect(repo.getProcedureTree()).toBeUndefined();
  });
});
