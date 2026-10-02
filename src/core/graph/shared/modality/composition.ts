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
 * One content unit's plan: ordered render requests, discriminated on
 * `provider` so `input` is typed to that provider's `inputSchema`. Callers may
 * `.extend()` it (procedures add `relevance`) and pass it back as `unitSchema`.
 */
export function buildUnitPlanSchema(providers: ModalityProvider<unknown>[]) {
  const requestOptions = providers.map((p) =>
    z.object({
      provider: z.literal(p.id),
      input: p.inputSchema,
      alt: z
        .string()
        .min(1)
        .describe(
          "The complete content of this part, every fact it states — later steps read only this, never the rendered part"
        ),
    })
  );

  // Runtime-sized array, never a compile-time tuple; cast needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requestSchema = z.discriminatedUnion("provider", requestOptions as any);

  return z.object({
    requests: z
      .array(requestSchema)
      .min(1)
      .describe("Ordered render requests composing this unit's final value"),
  });
}

/**
 * Planner output grammar: `{ plans }`, read back with {@link plansByKey}.
 *
 * Known unit set (`unitKeys`: chief complaint, procedures, anamnesis with
 * configured categories): `plans` is an object with one required property per
 * key and no others, so every unit appears exactly once by construction.
 *
 * Omitted (freeform anamnesis, `catalogs.anamnesis.list()` undefined): planner
 * names units, so `plans` is an array of `{ key, ...unit }`, `.min(1)`. Not a
 * record: OpenAI strict mode rejects open-keyed objects. No default category
 * list; clinical content stays out of code. Empty `unitKeys` is a caller bug
 * and throws.
 */
export function buildCompositionSchema(
  providers: ModalityProvider<unknown>[],
  unitKeys?: string[],
  unitSchema: z.ZodObject = buildUnitPlanSchema(providers)
): z.ZodTypeAny {
  if (unitKeys && unitKeys.length === 0) {
    throw new Error(
      "buildCompositionSchema requires at least one content-unit key — an empty field has nothing to plan. Pass `undefined` for a freeform field whose units the planner names itself."
    );
  }

  return z.object({
    plans: unitKeys
      ? z.strictObject(
          Object.fromEntries(unitKeys.map((key) => [key, unitSchema]))
        )
      : z
          .array(
            z.object({
              key: z
                .string()
                .min(1)
                .describe("Name this content unit yourself"),
              ...unitSchema.shape,
            })
          )
          .min(1),
  });
}

/** `plans` from {@link buildCompositionSchema}, either shape, keyed by unit. */
export function plansByKey<T>(
  plans: Record<string, T> | (T & { key: string })[]
): Record<string, T> {
  if (!Array.isArray(plans)) return plans;
  return Object.fromEntries(
    plans.map(({ key, ...unit }) => [key, unit as unknown as T])
  );
}
