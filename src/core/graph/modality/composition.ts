import z from "zod";
import type { ModalityProvider } from "./ports.js";

/**
 * One line per registered provider, for the planner's system prompt: id,
 * MIME and a plain-English description of what it renders. The planner
 * never sees more than this — it picks a provider by `id` and supplies that
 * provider's own `input`, it never learns how rendering actually happens.
 */
export function describeProviders(
  providers: ModalityProvider<unknown>[]
): string {
  return providers
    .map((p) => `- "${p.id}" (${p.mime}): ${p.description}`)
    .join("\n");
}

/**
 * Builds the planner's output grammar from the field's registered providers
 * and this call's content-unit keys — building an LLM grammar from runtime
 * configuration is an established pattern in this codebase, not a novelty:
 * see `catalog/procedures/candidates.ts`'s `ProcedureCandidates.grammar()`
 * and `models/Language.ts`'s `makeLanguageSchema`.
 *
 * Each request is discriminated on `provider` so its `input` is typed to
 * that specific provider's `inputSchema` — a request naming provider "text"
 * cannot carry an image provider's input shape, and vice versa.
 *
 * zod v4's `discriminatedUnion` was verified (see `composition.test.ts`) to
 * accept a single-element option array without complaint, so there is no
 * "one provider" special case here — the same construction covers a
 * one-provider and a many-provider field alike.
 *
 * `unitKeys` is **optional**, and omitting it is not the same as passing an
 * empty array. A field with a known unit set (chief complaint's single unit;
 * anamnesis under a configured category catalogue) passes it, and the
 * grammar then pins both the key names and the plan count. A field whose
 * units are not known ahead of the call — anamnesis in *freeform* mode,
 * where `catalogs.anamnesis.list()` returns `undefined` because the deployer
 * configured no category list — omits it, and the planner names its own
 * units under a plain `z.string()` key with only a `.min(1)` count. That is
 * what the pre-planner generator did (`buildAnamnesisFieldSchema()` with no
 * categories left `category` a bare `z.string()`), and it must keep working:
 * hardcoding a default category list here would bake opinionated clinical
 * content into code, which is exactly what the catalogue layer exists to
 * keep out of it. An explicitly empty array stays an error — that is a
 * caller bug, not a configuration.
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

  // `providers` is a runtime-sized array (deployment configuration, exactly
  // the pattern this doc comment points at above), so its length can never
  // be a compile-time tuple — this cast is the same shape as
  // `modalityDecision`'s/`makeLanguageSchema`'s `as [string, ...string[]]`,
  // just for a Zod schema array instead of a string array.
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
