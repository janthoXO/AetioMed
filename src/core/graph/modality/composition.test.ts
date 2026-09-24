import { describe, expect, it } from "vitest";
import z from "zod";
import { buildCompositionSchema, describeProviders } from "./composition.js";
import type { ModalityProvider } from "./ports.js";

function textProvider(id = "text"): ModalityProvider<unknown> {
  return {
    id,
    mime: "text/plain",
    description: `renders "${id}" prose from a natural-language instruction`,
    inputSchema: z.object({ instruction: z.string().min(1) }),
    render: async () => [],
  };
}

describe("describeProviders", () => {
  it("lists id, mime and description, one line per provider", () => {
    const text = textProvider();
    const image: ModalityProvider<unknown> = {
      id: "image",
      mime: "image/png",
      description: "renders a diagram",
      inputSchema: z.object({ prompt: z.string() }),
      render: async () => [],
    };

    const description = describeProviders([text, image]);
    expect(description).toContain('"text" (text/plain)');
    expect(description).toContain('"image" (image/png)');
  });
});

describe("buildCompositionSchema", () => {
  it("rejects an empty unitKeys array with a real error, not a bad cast", () => {
    expect(() => buildCompositionSchema([textProvider()], [])).toThrow();
  });

  it("accepts a single-provider registry — zod v4's discriminatedUnion does not reject a one-element option array", () => {
    const schema = buildCompositionSchema([textProvider()], ["unit-a"]);
    const result = schema.safeParse({
      plans: [
        {
          key: "unit-a",
          requests: [
            { provider: "text", input: { instruction: "hi" }, alt: "Hi." },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("admits only registered provider ids, rejecting an unregistered one", () => {
    const schema = buildCompositionSchema([textProvider()], ["unit-a"]);
    const result = schema.safeParse({
      plans: [
        {
          key: "unit-a",
          requests: [{ provider: "not-registered", input: {}, alt: "x" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("requires exactly one plan per unit key and rejects an unknown key", () => {
    const schema = buildCompositionSchema(
      [textProvider()],
      ["unit-a", "unit-b"]
    );
    const result = schema.safeParse({
      plans: [
        {
          key: "unit-a",
          requests: [
            { provider: "text", input: { instruction: "hi" }, alt: "Hi." },
          ],
        },
        {
          key: "unknown-unit",
          requests: [
            { provider: "text", input: { instruction: "hi" }, alt: "Hi." },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("discriminates a two-provider registry by the provider's own input schema", () => {
    const schema = buildCompositionSchema(
      [
        textProvider("text"),
        {
          id: "image",
          mime: "image/png",
          description: "renders a diagram",
          inputSchema: z.object({ prompt: z.string() }),
          render: async () => [],
        },
      ],
      ["unit-a"]
    );

    const ok = schema.safeParse({
      plans: [
        {
          key: "unit-a",
          requests: [
            { provider: "image", input: { prompt: "draw" }, alt: "A diagram." },
          ],
        },
      ],
    });
    expect(ok.success).toBe(true);

    // Wrong input shape for the named provider.
    const bad = schema.safeParse({
      plans: [
        {
          key: "unit-a",
          requests: [
            { provider: "image", input: { instruction: "hi" }, alt: "x" },
          ],
        },
      ],
    });
    expect(bad.success).toBe(false);
  });
});

const textRequest = (instruction: string) => ({
  provider: "text",
  input: { instruction },
  alt: instruction,
});

describe("buildCompositionSchema — freeform units", () => {
  // No configured category catalogue (`catalogs.anamnesis.list()` undefined): planner names its own units.
  // No default category list; clinical content stays out of code.
  const providers = [textProvider()];

  it("accepts planner-named keys and any unit count when unitKeys is omitted", () => {
    const schema = buildCompositionSchema(providers);
    const parsed = schema.parse({
      plans: [
        { key: "Whatever The Model Chose", requests: [textRequest("a")] },
        { key: "Another", requests: [textRequest("b")] },
      ],
    });
    expect(parsed.plans).toHaveLength(2);
  });

  it("still pins key names and plan count when unitKeys is given", () => {
    const schema = buildCompositionSchema(providers, ["History"]);
    expect(() =>
      schema.parse({
        plans: [{ key: "Not A Category", requests: [textRequest("a")] }],
      })
    ).toThrow();
  });

  it("rejects an explicitly empty unitKeys array — a caller bug, not a configuration", () => {
    expect(() => buildCompositionSchema(providers, [])).toThrow(
      /at least one content-unit key/
    );
  });
});
