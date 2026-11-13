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
  const requestOptions = providers.map((p) => {
    const request = z.object({
      provider: z.literal(p.id),
      alt: z
        .string()
        .min(1)
        .describe(
          "The complete content of this part, every fact it states — later steps read only this, never the rendered part"
        ),
    });
    // Empty input (text providers) left out of the grammar; `renderPlan`
    // passes `{}`. An `{}` the model must emit lets it pad whitespace inside
    // the braces forever (Gemma on vLLM/xgrammar never closed it). Not a zod
    // transform: LangChain cannot convert one inside a union.
    return isEmptyObject(p.inputSchema)
      ? request
      : request.extend({ input: p.inputSchema });
  });

  // One provider: its object directly. Same parse, but no one-branch union in
  // the grammar (Anthropic caps unions per request, every grammar pays for one).
  // Runtime-sized array, never a compile-time tuple; cast needed.
  const requestSchema =
    requestOptions.length === 1
      ? requestOptions[0]!
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        z.discriminatedUnion("provider", requestOptions as any);

  return z.object({
    requests: z
      .array(requestSchema)
      .min(1)
      .describe("Ordered render requests composing this unit's final value"),
  });
}

function isEmptyObject(schema: z.ZodType): boolean {
  return (
    schema instanceof z.ZodObject && Object.keys(schema.shape).length === 0
  );
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
 * and throws. `unitSchema(key)` lets each known unit get its own providers
 * ({@link allowedProviders}); freeform units share `unitSchema()`.
 */
export function buildCompositionSchema(
  providers: ModalityProvider<unknown>[],
  unitKeys?: string[],
  unitSchema: (key?: string) => z.ZodObject = () =>
    buildUnitPlanSchema(providers)
): z.ZodTypeAny {
  if (unitKeys && unitKeys.length === 0) {
    throw new Error(
      "buildCompositionSchema requires at least one content-unit key — an empty field has nothing to plan. Pass `undefined` for a freeform field whose units the planner names itself."
    );
  }

  return z.object({
    plans: unitKeys
      ? z.strictObject(
          Object.fromEntries(unitKeys.map((key) => [key, unitSchema(key)]))
        )
      : z
          .array(
            z.object({
              key: z
                .string()
                .min(1)
                .describe("Name this content unit yourself"),
              ...unitSchema().shape,
            })
          )
          .min(1),
  });
}

/**
 * Provider allow-list of one unit (procedure, anamnesis category). A provider
 * named by ANY unit of the field (`named`) is offered only to the units naming
 * it; an unnamed provider to every unit. Fields are independent: `named` comes
 * from that field's own catalogue. No catalogue (freeform) names nothing.
 */
export function allowedProviders(
  providers: ModalityProvider<unknown>[],
  named: ReadonlySet<string>,
  own: readonly string[] = []
): ModalityProvider<unknown>[] {
  return providers.filter((p) => !named.has(p.id) || own.includes(p.id));
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
