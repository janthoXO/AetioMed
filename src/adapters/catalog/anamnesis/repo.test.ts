// `createAnamnesisRepo` over a real temp DB + catalogDir: mixed string / `{ name, providers }` entries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/adapters/persistence/db.js";
import { createAnamnesisRepo } from "./repo.js";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aetiomed-anamnesis-repo-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createAnamnesisRepo — providers", () => {
  it("keeps names in order and looks up providers", () => {
    const catalogDir = path.join(tmpRoot, "catalog");
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(
      path.join(catalogDir, "anamnesisCategories.yml"),
      "categories:\n  - Medications\n  - name: Family History\n    providers: [pedigree]\n  - Allergies\n"
    );
    const dbHandle = createDb(fs.mkdtempSync(path.join(tmpRoot, "cache-")));
    const repo = createAnamnesisRepo(dbHandle, catalogDir);
    expect(repo.getEffectiveCategoryList()).toEqual([
      "Medications",
      "Family History",
      "Allergies",
    ]);
    expect(repo.getCategoryProviders("Family History")).toEqual(["pedigree"]);
    expect(repo.getCategoryProviders("Medications")).toBeUndefined();
    dbHandle.close();
  });
});
