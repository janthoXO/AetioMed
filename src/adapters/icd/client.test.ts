import { describe, expect, it, vi } from "vitest";
import { createIcdClient, probeIcd } from "./client.js";

const URL = "http://icd:80";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function client(fetchFn: typeof fetch) {
  return createIcdClient({
    url: `${URL}/`,
    release: "2026-01",
    fetch: fetchFn,
  });
}

describe("createIcdClient.get", () => {
  it("builds URL + query and sends the three headers", async () => {
    const f = vi.fn(async () => json({ ok: 1 }));
    const out = await client(f as unknown as typeof fetch).get(
      "/search",
      "de",
      {
        query: { q: "flu" },
      }
    );
    expect(out).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL}/icd/release/11/2026-01/mms/search?q=flu`);
    expect(init.headers).toEqual({
      Accept: "application/json",
      "API-Version": "v2",
      "Accept-Language": "de",
    });
  });
});

describe("probeIcd", () => {
  const probe = (f: typeof fetch, langs = ["en", "de"]) =>
    probeIcd(client(f), URL, langs);

  it("passes when every language is loaded", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(
      probe((async () =>
        json({ availableLanguages: ["de", "en"] })) as typeof fetch)
    ).resolves.toBeUndefined();
  });

  it("names the url when unreachable", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(probe(f)).rejects.toThrow(/unreachable.*http:\/\/icd:80/);
  });

  it("names the release on 404", async () => {
    const f = (async () =>
      new Response("nope", { status: 404 })) as typeof fetch;
    await expect(probe(f)).rejects.toThrow(/2026-01/);
  });

  it("names a language the container does not load", async () => {
    const f = (async () =>
      json({ availableLanguages: ["de", "en"] })) as typeof fetch;
    await expect(probe(f, ["en", "fr"])).rejects.toThrow(/language\(s\): fr\./);
  });
});
