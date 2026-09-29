import { TypeSafeClient, noul, type SystemOneRequest } from "@typesafe-ai/sdk";
import type { SystemOnePort } from "@/core/graph/runtime.js";

/** laya-serve's `MAX_QUESTIONS`: more per request is rejected. */
export const MAX_QUESTIONS_PER_REQUEST = 64;

/** Real `SystemOnePort`: Jev-wire client (laya-serve), questions chunked and sent concurrently. */
export function createSystemOnePort(cfg: {
  url: string;
  model: string;
  apiKey?: string | undefined;
  maxLen?: number | undefined;
}): SystemOnePort {
  const client = new TypeSafeClient({
    baseURL: cfg.url,
    apiKey: cfg.apiKey ?? "unused", // required by the SDK; laya-serve ignores it unless LAYA_API_KEY is set
    defaultModel: cfg.model,
    timeout: 120_000, // CPU inference over many questions is slow
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
          const req = {
            state,
            questions: Object.fromEntries(chunk.map(([k, q]) => [k, noul(q)])),
            ...(cfg.maxLen ? { max_len: cfg.maxLen } : {}),
          } as SystemOneRequest;
          const res = (await client.systemOne(
            req,
            context?.signal ? { signal: context.signal } : {}
          )) as { answers: Record<string, { noul: number }> };
          return chunk.map(([k]) => [k, res.answers[k]!.noul] as const);
        })
      );
      return Object.fromEntries(results.flat());
    },
  };
}
