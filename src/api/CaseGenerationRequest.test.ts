import { describe, expect, it } from "vitest";
import { makeCaseGenerationRequestSchema } from "./CaseGenerationRequest.js";
import { ConfigSchema } from "@/core/graph/config.js";

const schema = makeCaseGenerationRequestSchema(
  ConfigSchema.parse({ LLM_PROVIDER: "ollama", LLM_MODEL: "llama3.1" })
);

describe("CaseGenerationRequestSchema — generationFlags", () => {
  it("rejects an explicit empty array", () => {
    // `.min(1)` must reject `[]` at API boundary: 400, not 500 from graph.
    const result = schema.safeParse({
      diagnosis: "Influenza",
      generationFlags: [],
    });

    expect(result.success).toBe(false);
  });

  it("defaults to all four fields when omitted", () => {
    const result = schema.parse({ diagnosis: "Influenza" });

    expect(result.generationFlags).toEqual([
      "patient",
      "chiefComplaint",
      "anamnesis",
      "procedures",
    ]);
  });

  it("accepts a procedures-only request — the service expands it internally", () => {
    const result = schema.parse({
      diagnosis: "Influenza",
      generationFlags: ["procedures"],
    });

    expect(result.generationFlags).toEqual(["procedures"]);
  });
});

describe("CaseGenerationRequestSchema — language", () => {
  it("accepts a language in the deployment's configured LANGUAGES", () => {
    const configuredSchema = makeCaseGenerationRequestSchema(
      ConfigSchema.parse({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.1",
        LANGUAGES: "en,de,fr",
      })
    );

    const result = configuredSchema.safeParse({
      diagnosis: "Influenza",
      language: "fr",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a language outside the deployment's configured LANGUAGES as a validation (400-worthy) failure, not a 500", () => {
    // Default LANGUAGES is en,de — es is not configured.
    const result = schema.safeParse({
      diagnosis: "Influenza",
      language: "es",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a language name: the wire value is a code", () => {
    const result = schema.safeParse({
      diagnosis: "Influenza",
      language: "German",
    });

    expect(result.success).toBe(false);
  });
});
