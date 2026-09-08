// Config resolution takes the environment as an argument
// (`ConfigSchema.parse({...})`) rather than reading `process.env` — these
// tests never mutate `process.env`, they just pass different shapes in.
import { describe, expect, it, vi } from "vitest";
import type { ChatOllama } from "@langchain/ollama";
import { ConfigSchema } from "./config.js";
import { createLlmPort } from "./utils/llm.js";
import { LLM_ROLES } from "./runtime.js";

describe("ConfigSchema — LLM role resolution", () => {
  it("with only the general LLM configured, all three roles resolve to it", () => {
    const config = ConfigSchema.parse({
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "llama3.1",
      LLM_API_KEY: "general-key",
      LLM_URL: "http://general:11434",
    });

    const expected = {
      provider: "ollama",
      model: "llama3.1",
      apiKey: "general-key",
      url: "http://general:11434",
    };
    expect(config.llmRoles).toEqual({
      generator: expected,
      judge: expected,
      translator: expected,
    });
  });

  it("per-field fallback: LLM_JUDGE_MODEL alone inherits general provider/key/url", () => {
    const config = ConfigSchema.parse({
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "llama3.1",
      LLM_API_KEY: "general-key",
      LLM_URL: "http://general:11434",
      LLM_JUDGE_MODEL: "llama3.1:70b",
    });

    expect(config.llmRoles?.judge).toEqual({
      provider: "ollama",
      model: "llama3.1:70b",
      apiKey: "general-key",
      url: "http://general:11434",
    });
    // The other two roles are untouched by the judge override.
    expect(config.llmRoles?.generator.model).toBe("llama3.1");
    expect(config.llmRoles?.translator.model).toBe("llama3.1");
  });

  it("a role with PROVIDER and no MODEL fails startup validation naming the role", () => {
    expect(() =>
      ConfigSchema.parse({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.1",
        LLM_JUDGE_PROVIDER: "google",
      })
    ).toThrowError(/LLM_JUDGE_PROVIDER.*LLM_JUDGE_MODEL/s);
  });

  it("warns (does not fail) when a role's provider differs and it has no API key of its own", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const config = ConfigSchema.parse({
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "llama3.1",
      LLM_JUDGE_PROVIDER: "google",
      LLM_JUDGE_MODEL: "gemini-2.0-flash",
    });

    expect(config.llmRoles?.judge).toEqual({
      provider: "google",
      model: "gemini-2.0-flash",
      apiKey: undefined,
      url: undefined,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/LLM_JUDGE_PROVIDER.*LLM_JUDGE_API_KEY/s)
    );

    warnSpy.mockRestore();
  });

  it("under ALLOW_LLMS, llmRoles is undefined", () => {
    const config = ConfigSchema.parse({
      FEATURES: "ALLOW_LLMS",
      ALLOWED_LLMS: "ollama:llama3.1,google:gemini-2.0-flash",
    });

    expect(config.llmRoles).toBeUndefined();
    expect(config.llm).toBeUndefined();
  });

  it("under ALLOW_LLMS, a request llmConfig drives all three roles", () => {
    const config = ConfigSchema.parse({
      FEATURES: "ALLOW_LLMS",
      ALLOWED_LLMS: "ollama:llama3.1",
    });

    const port = createLlmPort(config);
    for (const role of LLM_ROLES) {
      const chat = port.for(
        { role, temperature: "deterministic" },
        { provider: "ollama", model: "llama3.1" }
      ) as ChatOllama;
      expect(chat.model).toBe("llama3.1");
    }
  });
});

describe("ConfigSchema — LANGUAGES (issue 09 §1)", () => {
  const base = { LLM_PROVIDER: "ollama" as const, LLM_MODEL: "llama3.1" };

  it("defaults to English, German when unset", () => {
    const config = ConfigSchema.parse(base);
    expect(config.LANGUAGES).toEqual(["English", "German"]);
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    const config = ConfigSchema.parse({
      ...base,
      LANGUAGES: "English, German , French",
    });
    expect(config.LANGUAGES).toEqual(["English", "German", "French"]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    const config = ConfigSchema.parse({
      ...base,
      LANGUAGES: "German,English,German,French,English",
    });
    expect(config.LANGUAGES).toEqual(["German", "English", "French"]);
  });

  it("rejects a set that omits English", () => {
    expect(() =>
      ConfigSchema.parse({ ...base, LANGUAGES: "German,French" })
    ).toThrowError(/must include "English"/);
  });

  it("treats a blank LANGUAGES string as unset, falling back to the default", () => {
    // Not a rejection: an operator who exports LANGUAGES= with nothing after
    // it means "I did not configure this", and the default already includes
    // English, so there is nothing to fail on.
    const config = ConfigSchema.parse({ ...base, LANGUAGES: "   " });
    expect(config.LANGUAGES).toEqual(["English", "German"]);
  });
});
