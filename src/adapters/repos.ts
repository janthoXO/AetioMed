// Composition helper: opens the embedded database and constructs every repo
// from it. Importing this module performs no I/O — nothing runs until
// `createRepos()` is called, from the composition root (`app.ts`) or a test.
import { createDb, type DbHandle } from "./persistence/db.js";
import {
  createProceduresRepo,
  type ProceduresRepo,
} from "./catalog/procedures/index.js";
import {
  createAnamnesisRepo,
  type AnamnesisRepo,
} from "./catalog/anamnesis/index.js";
import { createLabelsRepo, type LabelsRepo } from "./catalog/labels/index.js";
import {
  createDiagnosisRepo,
  type DiagnosisRepo,
} from "./catalog/diagnosis/index.js";
import { createSymptomCache, createUmlsSymptomFloor } from "./symptoms/repo.js";
import type {
  SymptomCache,
  UmlsSymptomFloor,
} from "@/core/graph/02-plan/01-basis/ports.js";

export interface Repos {
  db: DbHandle;
  procedures: ProceduresRepo;
  anamnesis: AnamnesisRepo;
  labels: LabelsRepo;
  diagnosis: DiagnosisRepo;
  umlsFloor: UmlsSymptomFloor;
  symptomCache: SymptomCache;
}

export function createRepos(opts: {
  /** Already-resolved absolute path (see `paths.ts`). */
  catalogDir: string;
  /** Already-resolved absolute path (see `paths.ts`). */
  cacheDir: string;
  symptomCacheTtlDays: number;
}): Repos {
  const db = createDb(opts.cacheDir);

  return {
    db,
    procedures: createProceduresRepo(db, opts.catalogDir),
    anamnesis: createAnamnesisRepo(db, opts.catalogDir),
    labels: createLabelsRepo(db, opts.catalogDir),
    diagnosis: createDiagnosisRepo(db, opts.catalogDir),
    umlsFloor: createUmlsSymptomFloor(opts.catalogDir),
    symptomCache: createSymptomCache(db, opts.symptomCacheTtlDays),
  };
}

export type {
  DbHandle,
  ProceduresRepo,
  AnamnesisRepo,
  LabelsRepo,
  DiagnosisRepo,
  UmlsSymptomFloor,
  SymptomCache,
};
