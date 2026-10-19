import { z } from "zod";

export class IcdHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "IcdHttpError";
  }
}

/** A container answers in milliseconds; past this it is down, not slow. */
const ICD_TIMEOUT_MS = 10_000;

/** Thin GET against one ICD-11 MMS release. `path` is relative to `/icd/release/11/{release}/mms`. */
export function createIcdClient(opts: {
  url: string;
  release: string;
  fetch?: typeof fetch;
}) {
  const doFetch = opts.fetch ?? fetch;
  const base = `${opts.url.replace(/\/$/, "")}/icd/release/11/${opts.release}/mms`;
  return {
    release: opts.release,
    async get(
      path: string,
      lang: string,
      init?: { signal?: AbortSignal; query?: Record<string, string> }
    ): Promise<unknown> {
      const qs = init?.query ? `?${new URLSearchParams(init.query)}` : "";
      const res = await doFetch(`${base}${path}${qs}`, {
        headers: {
          Accept: "application/json",
          "API-Version": "v2",
          "Accept-Language": lang,
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(ICD_TIMEOUT_MS),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      if (!res.ok) throw new IcdHttpError(res.status, await res.text());
      return res.json();
    },
  };
}

export type IcdClient = ReturnType<typeof createIcdClient>;

const ReleaseSchema = z.object({ availableLanguages: z.array(z.string()) });

/**
 * Startup probe: release exists and every configured language is loaded. With ICD configured everything
 * goes through ICD, so any failure is fatal: throws an Error whose message names the cause.
 */
export async function probeIcd(
  client: IcdClient,
  url: string,
  languages: readonly string[]
): Promise<void> {
  let body: unknown;
  try {
    body = await client.get("", "en");
  } catch (e) {
    if (e instanceof IcdHttpError) {
      throw new Error(
        e.status === 404
          ? `ICD release ${client.release} not found at ${url}`
          : `ICD API at ${url} answered ${e.status}: ${e.message}`,
        { cause: e }
      );
    }
    throw new Error(
      `ICD API unreachable at ${url}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
  const parsed = ReleaseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`ICD API at ${url} returned no availableLanguages`);
  }
  const loaded = parsed.data.availableLanguages;
  const missing = languages.filter((l) => !loaded.includes(l));
  if (missing.length > 0) {
    throw new Error(
      `ICD container at ${url} does not load language(s): ${missing.join(", ")}. ` +
        `Loaded: ${[...loaded].sort().join(", ")}. Fix the container's include or LANGUAGES.`
    );
  }
  console.info(
    `[icd] ${url} release ${client.release}, languages ${[...loaded].sort().join(", ")}`
  );
}
