import type { WebSearch } from "@/core/graph/runtime.js";

/** Characters kept per result: `content` is the whole page, often 100k+. */
const MAX_CONTENT_CHARS = 4000;

/** Ollama's hosted web search (`POST /api/web_search`); same API key as the Ollama cloud models. */
export function createOllamaWebSearch(opts: {
  apiKey: string;
  url?: string | undefined;
  maxResults?: number | undefined;
}): WebSearch {
  const endpoint = `${opts.url ?? "https://ollama.com"}/api/web_search`;
  return async (query, context) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, max_results: opts.maxResults ?? 3 }),
      signal: context?.signal ?? null,
    });
    if (!res.ok) {
      throw new Error(`Web search failed: HTTP ${res.status}`);
    }
    const { results } = (await res.json()) as {
      results: { title: string; url: string; content: string }[];
    };
    return results.map((r) => ({
      ...r,
      content: r.content.slice(0, MAX_CONTENT_CHARS),
    }));
  };
}
