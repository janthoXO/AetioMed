import type { IcdEntity, IcdPort, IcdSearchHit } from "@/core/diagnosis/icd.js";

/**
 * Test adapter. `entries[language]` lists that language's entities; search
 * returns every entry whose title or a synonym contains the text, in order.
 */
export function createInMemoryIcd(
  entries: Record<string, IcdSearchHit[]>
): IcdPort {
  return {
    async entity(code, language): Promise<IcdEntity | undefined> {
      const hit = entries[language]?.find((e) => e.code === code);
      return hit && { code: hit.code, title: hit.title };
    },
    async search(text, language) {
      const needle = text.toLowerCase();
      return (entries[language] ?? []).filter((e) =>
        [e.title, ...e.synonyms].some((s) => s.toLowerCase().includes(needle))
      );
    },
  };
}
