import z from "zod";
import type { ModalityProvider } from "./ports.js";

/** One line per provider for the planner's system prompt: id, MIME, description. Planner sees nothing more. */
export function describeProviders(
  providers: ModalityProvider<unknown>[]
): string {
  return providers
    .map((p) => `- "${p.id}" (${p.mime}): ${p.description}`)
    .join("\n");
}

/**
 * Planner output grammar from the field's providers and this call's unit keys.
 * Requests discriminated on `provider`, so `input` is typed to that provider's
 * `inputSchema`. Single-provider fields need no special case.
 *
 * `unitKeys` optional; omitting differs from empty array. Known unit set
 * (chief complaint; anamnesis with configured categories) pins key names and
 * plan count. Omitted (freeform anamnesis, `catalogs.anamnesis.list()`
 * undefined): planner names units, plain `z.string()` key, `.min(1)` count.
 * No default category list; clinical content stays out of code. Empty array
 * is a caller bug and throws.
 */
export function buildCompositionSchema(
  providers: ModalityProvider<unknown>[],
  unitKeys?: string[]
): z.ZodTypeAny {
  if (unitKeys && unitKeys.length === 0) {
    throw new Error(
      "buildCompositionSchema requires at least one content-unit key — an empty field has nothing to plan. Pass `undefined` for a freeform field whose units the planner names itself."
    );
  }

  const requestOptions = providers.map((p) =>
    z.object({
      provider: z.literal(p.id),
      input: p.inputSchema,
      alt: z
        .string()
        .min(1)
        .describe(
          "Plain text describing exactly what this part should convey — the provider renders it, so it must be self-contained"
        ),
    })
  );

  // Runtime-sized array, never a compile-time tuple; cast needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requestSchema = z.discriminatedUnion("provider", requestOptions as any);

  const planSchema = z.object({
    key: unitKeys
      ? z.enum(unitKeys as [string, ...string[]])
      : z.string().min(1).describe("Name this content unit yourself"),
    requests: z
      .array(requestSchema)
      .min(1)
      .describe("Ordered render requests composing this unit's final value"),
  });

  return z.object({
    plans: unitKeys
      ? z.array(planSchema).length(unitKeys.length)
      : z.array(planSchema).min(1),
  });
}
