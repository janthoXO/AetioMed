import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { MODALITY_PROVIDER_MODULES } from "./index.js";
import {
  modalityToken,
  resolveModalityProviders,
  type ModalityProviderModule,
} from "./resolve.js";

const runtime = {} as GraphRuntime;
const OPT = "CHIEF_COMPLAINT_FAKE";

function fake(mode: "always" | "optional", field = "chiefComplaint") {
  const probe = vi.fn<(env: unknown) => Promise<void>>(async () => {});
  const provider = { id: "fake" };
  const create = vi.fn<(e: unknown, r: unknown, d: string) => unknown>(
    () => provider
  );
  const module = {
    id: "fake",
    fields: { [field]: { mode, description: "field desc" } },
    env: z.object({ FAKE_URL: z.url() }),
    probe,
    create,
  } as unknown as ModalityProviderModule;
  return { module, probe, create, provider };
}

afterEach(() => vi.restoreAllMocks());

describe("modalityToken", () => {
  it("upper-snakes field and id", () => {
    expect(modalityToken("chiefComplaint", "referral_letter")).toBe(
      "CHIEF_COMPLAINT_REFERRAL_LETTER"
    );
  });
});

describe("resolveModalityProviders", () => {
  it("rejects an unknown token, listing the known ones", async () => {
    const { module } = fake("optional");
    await expect(
      resolveModalityProviders([module], { MODALITY_PROVIDERS: "NOPE" })
    ).rejects.toThrow(`unknown NOPE. Known: ${OPT}`);
  });

  it("gives an always field no token", async () => {
    const { module } = fake("always");
    await expect(
      resolveModalityProviders([module], { MODALITY_PROVIDERS: OPT })
    ).rejects.toThrow(/unknown/);
  });

  it("does not create or probe an unlisted provider, warns when its env is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { module, probe, create } = fake("optional");

    const build = await resolveModalityProviders([module], {
      FAKE_URL: "http://x",
    });
    expect(build(runtime)).toEqual({});
    expect(probe).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();

    warn.mockClear();
    await resolveModalityProviders([module], { FAKE_URL: "" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a listed provider with a missing env var, naming it", async () => {
    const { module } = fake("optional");
    await expect(
      resolveModalityProviders([module], { MODALITY_PROVIDERS: OPT })
    ).rejects.toThrow(/"fake"/);
  });

  it("rejects when the probe throws, naming the provider", async () => {
    const { module, probe } = fake("optional");
    probe.mockRejectedValue(new Error("down"));
    await expect(
      resolveModalityProviders([module], {
        MODALITY_PROVIDERS: OPT,
        FAKE_URL: "http://x",
      })
    ).rejects.toThrow(/fake.*down/);
  });

  it("probes with parsed env and creates per field with its description", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { module, probe, create, provider } = fake("optional");
    const build = await resolveModalityProviders([module], {
      MODALITY_PROVIDERS: ` ${OPT} `,
      FAKE_URL: "http://x",
    });
    expect(probe).toHaveBeenCalledWith({ FAKE_URL: "http://x" });
    expect(build(runtime)).toEqual({ chiefComplaint: [provider] });
    expect(create).toHaveBeenCalledWith(
      { FAKE_URL: "http://x" },
      runtime,
      "field desc",
      undefined // the fake probe returns nothing
    );
  });

  it("activates an always provider without any token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { module, provider } = fake("always");
    const build = await resolveModalityProviders([module], {
      FAKE_URL: "http://x",
    });
    expect(build(runtime)).toEqual({ chiefComplaint: [provider] });
  });
});

describe("README-DEV.md", () => {
  it("documents MODALITY_PROVIDERS and every provider env var and token", () => {
    const readme = readFileSync(
      new URL("../../../README-DEV.md", import.meta.url),
      "utf8"
    );
    expect(readme).toContain("MODALITY_PROVIDERS");
    for (const m of MODALITY_PROVIDER_MODULES) {
      for (const key of Object.keys(m.env.shape)) expect(readme).toContain(key);
      for (const [field, f] of Object.entries(m.fields)) {
        if (f.mode === "optional")
          expect(readme).toContain(modalityToken(field as never, m.id));
      }
    }
  });
});
