import { translateTermsKeyed } from "@/core/graph/shared/translation/translate.js";
import {
  CATEGORY_PREFIX,
  OUTLINE_SECTIONS,
  SECTION_PREFIX,
  type OutlineSegments,
} from "@/core/graph/shared/outline/segments.js";
import type { OutlineHeadingCatalog } from "@/core/graph/catalog/ports.js";
import type { ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { RequestContext } from "@/core/graph/utils/context.js";

/**
 * Request-language text of every server-owned heading in a generated outline
 * (English skeleton), by segment index: section titles from the outline-heading
 * catalogue, configured anamnesis categories from the anamnesis catalogue.
 * Misses are translated in one call and persisted, so every later plan shows
 * the same headings; curated YAML always wins over a persisted fill.
 * LLM-named (freeform) category headings are absent: they are case content,
 * left to the caller.
 */
export async function localizeHeadings(
  runtime: GraphRuntime,
  segments: OutlineSegments,
  language: ForeignLanguage,
  context?: RequestContext
): Promise<Map<number, string>> {
  const { outlineHeadings, anamnesis } = runtime.catalogs;
  const levels = [
    [
      SECTION_PREFIX,
      new Set<string>(Object.values(OUTLINE_SECTIONS)),
      outlineHeadings,
    ],
    [CATEGORY_PREFIX, new Set(anamnesis.list() ?? []), anamnesis],
  ] as const;

  const slots = segments.flatMap((segment, index) => {
    if (!segment.fixed) return [];
    for (const [prefix, known, catalog] of levels) {
      const english = segment.text.slice(prefix.length);
      if (segment.text.startsWith(prefix) && known.has(english)) {
        return [
          { index, prefix, english, catalog: catalog as OutlineHeadingCatalog },
        ];
      }
    }
    return [];
  });

  const missing = slots.filter(
    (slot) => slot.catalog.fromEnglish(slot.english, language) === undefined
  );
  if (missing.length > 0) {
    const generated = await translateTermsKeyed(runtime, {
      logTag: "TranslateOutlineHeadings",
      taskDescription:
        "Translate the provided section headings of a clinical case outline from English to a target language. Each is a short heading title: translate it as a heading, without markdown.",
      contextLines: [`Target language: ${language}`],
      terms: [...new Set(missing.map((slot) => slot.english))],
      context,
    });
    for (const [, , catalog] of levels) {
      const own = missing.filter((slot) => slot.catalog === catalog);
      if (own.length > 0) {
        catalog.saveTranslations(
          Object.fromEntries(
            own.map((s) => [s.english, generated[s.english]!])
          ),
          language
        );
      }
    }
  }

  // Read back: a concurrent fill may have won (first writer wins).
  return new Map(
    slots.map((slot) => [
      slot.index,
      slot.prefix +
        (slot.catalog.fromEnglish(slot.english, language) ?? slot.english),
    ])
  );
}
