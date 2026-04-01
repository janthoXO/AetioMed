import Dexie, { type EntityTable } from "dexie";
import type { Case, CaseRun } from "@/models/Case";

// We store Omit<Case, "runs"> in the cases table, and CaseRun & { caseId: number } in the runs table
export type DBCase = Omit<Case, "runs">;
export type DBCaseRun = CaseRun;

const db = new Dexie("AetioMedDB") as Dexie & {
  cases: EntityTable<DBCase, "id">;
  runs: EntityTable<DBCaseRun, "runId">;
};

db.version(1).stores({
  cases: "++id, createdAt",
  runs: "++runId, caseId",
});

export { db };
