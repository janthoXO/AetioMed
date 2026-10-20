import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import z from "zod";
import type { ReferralLetterRenderer } from "@/core/graph/04-case/01-presentation/chief-complaint/providers.js";

/** AetioReferral's `render_referral_letter` result: one embedded PDF resource, base64. Parsed, never cast. */
const RenderResultSchema = z.object({
  content: z.tuple([
    z.object({
      type: z.literal("resource"),
      resource: z.object({
        mimeType: z.literal("application/pdf"),
        blob: z.base64(),
      }),
    }),
  ]),
});

/**
 * `ReferralLetterRenderer` over AetioReferral's MCP server (streamable HTTP).
 * One connection per letter: AetioReferral is stateless, and a letter is one
 * call per case. `patient: null` keeps the letter from naming a patient the
 * case's own `patient` could contradict.
 */
export function createMcpReferralLetterRenderer(
  url: string
): ReferralLetterRenderer {
  return async ({ sender_name, ...fields }, language, signal) => {
    const client = new Client({ name: "aetiomed", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const result = await client.callTool(
        {
          name: "render_referral_letter",
          arguments: {
            letter: {
              ...fields,
              // Unnamed referrer: AetioReferral makes one up.
              sender: sender_name ? { name: sender_name } : {},
              language, // ISO 639-1 is a valid BCP 47 tag
              patient: null,
            },
          },
        },
        signal ? { signal } : {}
      );
      if (result.isError) {
        throw new Error(
          `[AetioReferral] render_referral_letter failed: ${JSON.stringify(result.content)}`
        );
      }
      const { blob } = RenderResultSchema.parse(result).content[0].resource;
      return new Uint8Array(Buffer.from(blob, "base64"));
    } finally {
      await client.close();
    }
  };
}
