import { describe, expect, it } from "vitest";
import z from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { PatientSchema } from "@/core/graph/shared/domain/Patient.js";
import { ReferralLetterSchema } from "@/adapters/modality/referralLetter/draft.js";
import { keyedTranslationSchema } from "@/core/graph/shared/translation/translate.js";
import { buildCompositionSchema } from "@/core/graph/shared/modality/composition.js";
import type { ModalityProvider } from "@/core/graph/shared/modality/ports.js";
import { portableSchema } from "./portableSchema.js";

const portable = (schema: z.ZodType) =>
  portableSchema(toJsonSchema(schema) as Record<string, unknown>);

const provider = (id: string): ModalityProvider<unknown> => ({
  id,
  mime: "text/plain",
  description: id,
  inputSchema: z.object({ instruction: z.string().min(1) }),
  render: async () => [],
});

describe("portableSchema", () => {
  it("rewrites const to enum and oneOf to anyOf, closes objects, drops $schema", () => {
    const { schema } = portable(
      z.object({
        step: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a") }),
          z.object({ kind: z.literal("b"), n: z.number().min(1) }),
        ]),
      })
    );
    const json = JSON.stringify(schema);
    expect(json).not.toMatch(/"(const|oneOf|\$schema)"/);
    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        step: {
          anyOf: [
            { properties: { kind: { enum: ["a"] } } },
            // bounds are kept: lossless only
            { properties: { n: { minimum: 1 } } },
          ],
        },
      },
    });
  });

  it("wraps a non-object root and unwraps the answer, keeping $defs on the wrapper", () => {
    const { schema, unwrap } = portableSchema({
      anyOf: [{ $ref: "#/$defs/x" }, { type: "null" }],
      $defs: { x: { type: "string" } },
    });
    expect(schema).toMatchObject({
      type: "object",
      required: ["value"],
      $defs: { x: { type: "string" } },
      properties: {
        value: { anyOf: [{ $ref: "#/$defs/x" }, { type: "null" }] },
      },
    });
    expect(unwrap({ value: "x" })).toBe("x");
    expect(unwrap(undefined)).toBeUndefined();
  });

  it("throws on a record and on an optional field, naming the path", () => {
    expect(() =>
      portable(z.object({ m: z.record(z.string(), z.string()) }))
    ).toThrow(/record\) at \(root\)\.m/);
    expect(() => portable(z.object({ a: z.string().optional() }))).toThrow(
      /optional field\(s\) a at \(root\)/
    );
  });

  // LLM schemas no test drives through the port (the rest are covered by
  // every gateway test: the port runs portableSchema on each call).
  it.each([
    ["patient", PatientSchema],
    [
      "referral letters",
      z.object({ letters: z.array(ReferralLetterSchema).length(2) }),
    ],
    ["keyed translation", keyedTranslationSchema(["a", "b.c"])],
    [
      "composition, 2 providers, keys",
      buildCompositionSchema([provider("x"), provider("y")], ["k"]),
    ],
    [
      "composition, 2 providers, freeform",
      buildCompositionSchema([provider("x"), provider("y")]),
    ],
  ])("accepts the %s schema", (_name, schema) => {
    expect(() => portable(schema as z.ZodType)).not.toThrow();
  });
});
