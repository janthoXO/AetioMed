// List every LLM-generated (`source: "generated"`) translation row, grouped
// by domain and language, so they can be reviewed and promoted into the
// curated YAML config files.
//
// Usage:
//   pnpm translations:generated
//   pnpm translations:generated -- --domain Procedures
import { eq } from "drizzle-orm";
import { db } from "../src/core/graph/03repo/db.js";
import { translation } from "../src/core/graph/03repo/schema.js";

function parseDomainFilter(): string | undefined {
  const idx = process.argv.indexOf("--domain");
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function main() {
  const domainFilter = parseDomainFilter();

  const rows = (
    domainFilter
      ? db
          .select()
          .from(translation)
          .where(eq(translation.domain, domainFilter))
          .all()
      : db.select().from(translation).all()
  ).filter((row) => row.source === "generated");

  if (rows.length === 0) {
    console.log(
      domainFilter
        ? `No generated translations found for domain "${domainFilter}".`
        : "No generated translations found."
    );
    return;
  }

  const grouped = new Map<
    string,
    Map<string, { english: string; translated: string }[]>
  >();
  for (const row of rows) {
    let byLang = grouped.get(row.domain);
    if (!byLang) {
      byLang = new Map();
      grouped.set(row.domain, byLang);
    }
    let entries = byLang.get(row.lang);
    if (!entries) {
      entries = [];
      byLang.set(row.lang, entries);
    }
    entries.push({ english: row.english, translated: row.translated });
  }

  for (const [domain, byLang] of [...grouped.entries()].sort()) {
    console.log(`\n=== ${domain} ===`);
    for (const [lang, entries] of [...byLang.entries()].sort()) {
      console.log(`  ${lang}:`);
      for (const { english, translated } of entries.sort((a, b) =>
        a.english.localeCompare(b.english)
      )) {
        console.log(`    "${english}" -> "${translated}"`);
      }
    }
  }

  console.log(`\n${rows.length} generated translation(s) total.`);
}

main();
