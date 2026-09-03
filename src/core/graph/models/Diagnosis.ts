import z from "zod";
import { asc, eq } from "drizzle-orm";
import { chunk, db, syncSource } from "../03repo/db.js";
import { diagnosis } from "../03repo/schema.js";

export const ICDCodePattern = /([0-9A-Z]{1,4})(\.[A-Z0-9]{1,2})?/;

export const ICDCodeSchema = z.stringFormat("icd", ICDCodePattern);

export type ICDCode = z.infer<typeof ICDCodeSchema>;

export const DiagnosisSchema = z.object({
  name: z.string(),
  icd: ICDCodeSchema.optional(),
  alternativeNames: z.array(z.string()).optional(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

function rowToDiagnosis(row: typeof diagnosis.$inferSelect): Diagnosis {
  return {
    name: row.name,
    icd: row.icd,
    alternativeNames: JSON.parse(row.alternativeNames) as string[],
  };
}

function syncPredefinedDiagnoses() {
  const DiagnosisEntrySchema = z.object({
    code: ICDCodeSchema,
    names: z.array(z.string()),
  });

  const synced = syncSource("diagnosis", "data/diagnosis.yml", (parsed) => {
    const diagnosisEntries = z
      .record(ICDCodeSchema, DiagnosisEntrySchema.optional().catch(undefined))
      .transform((entries) => Object.values(entries).filter((e) => !!e))
      .safeParse(parsed);

    if (!diagnosisEntries.success) {
      console.error(diagnosisEntries.error);
      console.error(
        "[Diagnosis] Failed to load predefined diagnoses from YAML"
      );
      return;
    }

    // This source is a plain read-only list (no runtime additions), so a
    // full replace is safe and keeps removed/renamed entries in sync.
    db.delete(diagnosis).run();

    const rows: (typeof diagnosis.$inferInsert)[] = [];
    for (const entry of diagnosisEntries.data) {
      if (!entry.names || entry.names.length === 0) {
        console.warn(
          `[Diagnosis] Skipping entry with code ${entry.code} due to missing names`
        );
        continue;
      }
      rows.push({
        icd: entry.code,
        name: entry.names[0]!,
        alternativeNames: JSON.stringify(entry.names.slice(1)),
      });
    }

    for (const batch of chunk(rows)) {
      db.insert(diagnosis).values(batch).run();
    }
    console.info(
      `[Diagnosis] Synced ${rows.length} predefined diagnoses from YAML`
    );
  });

  if (!synced) {
    console.info(
      "[Diagnosis] data/diagnosis.yml unchanged, skipped YAML parse."
    );
  }
}

syncPredefinedDiagnoses();

/**
 * Look up a predefined diagnosis by its ICD-11 code.
 */
export function getDiagnosisByIcd(icd: ICDCode): Diagnosis | undefined {
  const row = db.select().from(diagnosis).where(eq(diagnosis.icd, icd)).get();
  return row ? rowToDiagnosis(row) : undefined;
}

/**
 * Every predefined diagnosis. Used by the `/diagnosis` listing endpoint.
 */
export function getAllDiagnoses(): Diagnosis[] {
  return db
    .select()
    .from(diagnosis)
    .orderBy(asc(diagnosis.icd))
    .all()
    .map(rowToDiagnosis);
}
