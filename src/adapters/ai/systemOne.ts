import {
  TypeSafeClient,
  choice,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import type { SystemOnePort } from "@/core/graph/runtime.js";

/**
 * Real `SystemOnePort`: Jev-wire client (laya-serve), one `choice` question per call.
 * laya-serve rejects more than 100 options per choice (413) and gets less accurate past ~20 —
 * the caller narrows first.
 */
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
    timeout: 120_000, // CPU inference is slow
  });
  return {
    async choice(state, instructions, options, context) {
      const req = {
        state,
        questions: {
          pick: choice(
            instructions,
            Object.fromEntries(options.map((o) => [o, null]))
          ),
        },
        ...(cfg.maxLen ? { max_len: cfg.maxLen } : {}),
      } as SystemOneRequest;
      const res = (await client.systemOne(
        req,
        context?.signal ? { signal: context.signal } : {}
      )) as unknown as {
        answers: { pick: { probabilities: Record<string, number> } };
      };
      const p = res.answers.pick.probabilities;
      return Object.fromEntries(options.map((o) => [o, p[o] ?? 0]));
    },
  };
}
