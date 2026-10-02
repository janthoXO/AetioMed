import type { MedicalBasisProvider } from "@/core/graph/02-plan/01-basis/ports.js";
import type { WebSearch, WebSearchResult } from "@/core/graph/runtime.js";

/** Search results as plain text: title, url, excerpt per result. */
export function renderSearchResults(results: WebSearchResult[]): string {
  return results
    .map((r) => `### ${r.title}\n${r.url}\n\n${r.content}`)
    .join("\n\n");
}

/**
 * Fixed queries on the diagnosis name, no LLM deciding what to search:
 * presentation and workup, the two things the outline must get right.
 */
export function createWebSearchProvider(
  webSearch: WebSearch
): MedicalBasisProvider {
  return {
    id: "web-search",
    description: "Web search results (clinical presentation and workup)",
    async fetch(query, context) {
      const name = query.diagnosis.name;
      const batches = await Promise.all(
        [
          `${name} clinical presentation symptoms signs`,
          `${name} diagnostic workup laboratory imaging findings`,
        ].map((q) => webSearch(q, context))
      );
      const seen = new Set<string>();
      const results = batches
        .flat()
        .filter((r) => !seen.has(r.url) && seen.add(r.url));
      return renderSearchResults(results) || undefined;
    },
  };
}
