import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import z from "zod";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import type { ReferralLetter } from "./draft.js";

/** Renders one drafted referral letter as a PDF in `language`. */
export type ReferralLetterRenderer = (
  letter: ReferralLetter,
  language: Language,
  signal?: AbortSignal
) => Promise<Uint8Array<ArrayBuffer>>;

const TOOL = "render_referral_letter";

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

/** One MCP session, closed afterwards: AetioReferral is stateless. */
async function withClient<T>(
  url: string,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({ name: "aetiomed", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Startup check: AetioReferral reachable and serving `render_referral_letter`. Throws otherwise. */
export function probeReferralMcp(url: string): Promise<void> {
  return retry(
    () =>
      withClient(url, async (client) => {
        const { tools } = await client.listTools();
        if (!tools.some((t) => t.name === TOOL)) {
          throw new Error(`[AetioReferral] ${url} serves no "${TOOL}" tool`);
        }
      }),
    2,
    1000
  );
}

/**
 * `ReferralLetterRenderer` over AetioReferral's MCP server (streamable HTTP).
 * One connection per letter, one retry. `patient: null` keeps the letter from
 * naming a patient the case's own `patient` could contradict.
 */
export function createMcpReferralLetterRenderer(
  url: string
): ReferralLetterRenderer {
  return ({ sender_name, ...fields }, language, signal) =>
    retry(
      () =>
        withClient(url, async (client) => {
          const result = await client.callTool(
            {
              name: TOOL,
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
              `[AetioReferral] ${TOOL} failed: ${JSON.stringify(result.content)}`
            );
          }
          const { blob } = RenderResultSchema.parse(result).content[0].resource;
          return new Uint8Array(Buffer.from(blob, "base64"));
        }),
      1,
      500
    );
}
