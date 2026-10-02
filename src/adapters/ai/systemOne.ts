import { TypeSafeClient, noul } from "@typesafe-ai/sdk";
import type { SystemOnePort } from "@/core/graph/runtime.js";

/**
 * Ollama packs state and every question of a request into one prompt with a
 * hard token cap (tev1: 2050, never truncated); 16 short questions next to a
 * short state already reach ~1300. Small chunks leave room for a long state.
 *
 * ponytail: fixed count, not a token estimate; lower it if a long workup
 * state hits the cap ("prompt 0 has N tokens").
 */
export const MAX_QUESTIONS_PER_REQUEST = 8;

/** Real `SystemOnePort`: Jev-wire client (Ollama ≥ 0.35 `/v1/systemone`), questions chunked and sent concurrently. */
export function createSystemOnePort(cfg: {
  url: string;
  model: string;
  apiKey?: string | undefined;
}): SystemOnePort {
  const client = new TypeSafeClient({
    baseURL: cfg.url,
    apiKey: cfg.apiKey ?? "unused", // required by the SDK; Ollama ignores it
    defaultModel: cfg.model,
    timeout: 120_000, // local inference over many questions is slow
  });
  return {
    async noul(state, questions, context) {
      const entries = Object.entries(questions);
      const chunks: [string, string][][] = [];
      for (let i = 0; i < entries.length; i += MAX_QUESTIONS_PER_REQUEST) {
        chunks.push(entries.slice(i, i + MAX_QUESTIONS_PER_REQUEST));
      }
      const results = await Promise.all(
        chunks.map(async (chunk) => {
          const res = (await client.systemOne(
            {
              state,
              questions: Object.fromEntries(
                chunk.map(([k, q]) => [k, noul(q)])
              ),
            },
            context?.signal ? { signal: context.signal } : {}
          )) as { answers: Record<string, { noul: number }> };
          return chunk.map(([k]) => [k, res.answers[k]!.noul] as const);
        })
      );
      return Object.fromEntries(results.flat());
    },
  };
}
