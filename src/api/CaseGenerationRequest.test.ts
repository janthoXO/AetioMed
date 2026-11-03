import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { makeCaseGenerationRequestSchema } from "./CaseGenerationRequest.js";
import { ConfigSchema } from "@/core/graph/config.js";

const schema = makeCaseGenerationRequestSchema(
  ConfigSchema.parse({ LLM_PROVIDER: "ollama", LLM_MODEL: "llama3.1" }),
  { icd: false }
);

/** Issues nested in a failed union, flattened: `{ path, message }` per branch issue. */
function nestedIssues(body: unknown) {
  const r = schema.safeParse(body);
  expect(r.success).toBe(false);
  return (r.error?.issues ?? []).flatMap((issue) =>
    issue.code === "invalid_union"
      ? issue.errors.flat().map((i) => ({ path: i.path, message: i.message }))
      : [{ path: issue.path, message: issue.message }]
  );
}

describe("CaseGenerationRequestSchema — first call vs continuation", () => {
  const plan = [
    { fixed: false, text: "" },
    { fixed: true, text: "## General" },
    { fixed: false, text: "" },
  ];

  it("first call defaults language to en and mode to normal", () => {
    const r = schema.parse({ diagnosis: "Influenza" });
    expect(r.language).toBe("en");
    expect(r.mode).toBe("normal");
  });

  it("a plan without mode fails, naming mode, and never parses as a first call", () => {
    const issues = nestedIssues({ diagnosis: "Influenza", plan });
    expect(issues.some((i) => i.path[0] === "mode")).toBe(true);
  });

  it("a plan with userInstructions parses and drops them", () => {
    const r = schema.parse({
      diagnosis: "Influenza",
      mode: "plan",
      plan,
      userInstructions: { general: "x" },
    });
    expect(r).toMatchObject({ mode: "plan", plan });
    expect("userInstructions" in r).toBe(false);
  });

  it("a plan with either explicit mode succeeds", () => {
    for (const mode of ["plan", "normal"]) {
      expect(
        schema.safeParse({ diagnosis: "Influenza", mode, plan }).success
      ).toBe(true);
    }
  });

  it("a non-canonical plan fails with the canonical-shape message", () => {
    const issues = nestedIssues({
      diagnosis: "Influenza",
      mode: "plan",
      plan: [{ fixed: true, text: "## General" }],
    });
    expect(
      issues.some(
        (i) =>
          i.path[0] === "plan" && i.message.startsWith("A plan must alternate")
      )
    ).toBe(true);
  });

  it("contract: first call forbids plan, continuation requires mode+plan and lists no userInstructions", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      anyOf: { properties: Record<string, unknown>; required?: string[] }[];
    };
    expect(json.anyOf).toHaveLength(2);
    const [first, cont] = json.anyOf;
    expect(first?.properties.plan).toMatchObject({ not: {} });
    expect(cont?.properties).not.toHaveProperty("userInstructions");
    expect(cont?.required).toEqual(expect.arrayContaining(["mode", "plan"]));
  });
});

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
      }),
      { icd: false }
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

describe("CaseGenerationRequestSchema — diagnosis by ICD config (#238)", () => {
  const base = { LLM_PROVIDER: "ollama", LLM_MODEL: "llama3.1" };
  const withIcd = makeCaseGenerationRequestSchema(ConfigSchema.parse(base), {
    icd: true,
  });
  const withoutIcd = makeCaseGenerationRequestSchema(ConfigSchema.parse(base), {
    icd: false,
  });

  it("ICD on: icd alone or a name alone is enough, neither is a 400", () => {
    expect(withIcd.safeParse({ icd: "CA40" }).success).toBe(true);
    expect(withIcd.safeParse({ diagnosis: "Pneumonia" }).success).toBe(true);
    expect(withIcd.safeParse({}).success).toBe(false);
  });

  it("ICD off: a name is required, icd only rides along", () => {
    expect(withoutIcd.safeParse({ icd: "CA40" }).success).toBe(false);
    expect(withoutIcd.safeParse({ diagnosis: "Pneumonia" }).success).toBe(true);
    expect(
      withoutIcd.safeParse({ diagnosis: "Pneumonia", icd: "CA40" }).success
    ).toBe(true);
  });
});
