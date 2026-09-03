import {
  index,
  int,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Per-source content fingerprint (sha256 of the raw YAML file), used by
 * `syncSource` in `db.ts` to skip re-parsing/re-ingesting unchanged files.
 */
export const meta = sqliteTable("_meta", {
  source: text("source").primaryKey(),
  hash: text("hash").notNull(),
});

/**
 * English -> target-language translations, scoped per domain (one per
 * `createTranslationStore` caller: Diagnosis, Procedures, Labels, Anamnesis).
 * Rows are upserted from YAML on sync; rows for keys absent from the YAML
 * (AI-generated translations) are never deleted by a sync.
 */
export const translation = sqliteTable(
  "translation",
  {
    domain: text("domain").notNull(),
    lang: text("lang").notNull(),
    english: text("english").notNull(),
    translated: text("translated").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.domain, table.lang, table.english] }),
    index("idx_translation_reverse").on(
      table.domain,
      table.lang,
      table.translated
    ),
  ]
);

/**
 * Predefined ICD-11 diagnoses, fully replaced on each YAML sync (read-only
 * list, no runtime additions).
 */
export const diagnosis = sqliteTable("diagnosis", {
  icd: text("icd").primaryKey(),
  name: text("name").notNull(),
  // JSON-encoded string[]
  alternativeNames: text("alternative_names").notNull(),
});

/**
 * Ordered, read-only lists synced from YAML: predefined procedure names and
 * default anamnesis categories, distinguished by `source`.
 */
export const predefinedItem = sqliteTable(
  "predefined_item",
  {
    source: text("source").notNull(),
    position: int("position").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.source, table.position] })]
);

/**
 * Cache-aside store for LLM-generated symptom additions, keyed by ICD-11
 * code. Holds only the LLM-generated symptoms (not the static UMLS floor
 * from `data/diagnosis_symptoms.json`), so a hit here skips the LLM call
 * entirely. `updatedAt` (epoch ms) backs a TTL freshness check in
 * `symptoms.repo.ts` — stale rows are treated as a miss and regenerated.
 */
export const symptomCache = sqliteTable("symptom_cache", {
  icd: text("icd").primaryKey(),
  // JSON-encoded Symptom[]
  symptoms: text("symptoms").notNull(),
  updatedAt: int("updated_at").notNull(),
});
