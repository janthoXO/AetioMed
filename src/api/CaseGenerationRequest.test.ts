import { describe, expect, it } from "vitest";
import { makeCaseGenerationRequestSchema } from "./CaseGenerationRequest.js";
import { ConfigSchema } from "@/core/graph/config.js";

const schema = makeCaseGenerationRequestSchema(
  ConfigSchema.parse({ LLM_PROVIDER: "ollama", LLM_MODEL: "llama3.1" })
);

describe("CaseGenerationRequestSchema — generationFlags", () => {
  it("rejects an explicit empty array", () => {
    // Before `.min(1)` this passed the API and then threw a Zod error deep
    // inside the graph (whose state schema *does* declare it), surfacing to
    // the caller as a 500 instead of a 400.
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
