import Dexie, { type EntityTable } from "dexie";
import type { Case } from "@/models/Case";

const db = new Dexie("AetioMedDB") as Dexie & {
  cases: EntityTable<Case, "id">;
};

db.version(1).stores({
  cases: "id, createdAt",
});

export { db };
