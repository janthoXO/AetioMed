// Composition helper: opens the embedded database and constructs every
// `03repo/` repo from it. Importing this module performs no I/O — nothing
// runs until `createRepos()` is called, from the composition root
// (`app.ts`) or a test.
import { createDb, type DbHandle } from "./db.js";
import {
  createProceduresRepo,
  type ProceduresRepo,
} from "./procedures.repo.js";
import { createAnamnesisRepo, type AnamnesisRepo } from "./anamnesis.repo.js";
import { createLabelsRepo, type LabelsRepo } from "./labels.repo.js";
import { createDiagnosisRepo, type DiagnosisRepo } from "./diagnosis.repo.js";
import { createSymptomsRepo, type SymptomsRepo } from "./symptoms.repo.js";

export interface Repos {
  db: DbHandle;
  procedures: ProceduresRepo;
  anamnesis: AnamnesisRepo;
  labels: LabelsRepo;
  diagnosis: DiagnosisRepo;
  symptoms: SymptomsRepo;
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
    symptoms: createSymptomsRepo(db, opts.catalogDir, opts.symptomCacheTtlDays),
  };
}

export type {
  DbHandle,
  ProceduresRepo,
  AnamnesisRepo,
  LabelsRepo,
  DiagnosisRepo,
  SymptomsRepo,
};
