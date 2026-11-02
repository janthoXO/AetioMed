import z from "zod";
import type { TranslationMapping } from "../../persistence/translationStore.js";
import { namesOf } from "../procedures/fhir.js";

// FHIR R4 CodeSystem, lenient: only the fields read are validated.
type Concept = {
  display?: string | undefined;
  designation?: { language?: string | undefined; value: string }[] | undefined;
  concept?: Concept[] | undefined;
};

const ConceptSchema: z.ZodType<Concept> = z.object({
  display: z.string().optional(),
  designation: z
    .array(z.object({ language: z.string().optional(), value: z.string() }))
    .optional(),
  get concept() {
    return z.array(ConceptSchema).optional();
  },
});

const CodeSystemSchema = z.object({
  resourceType: z.literal("CodeSystem").optional(),
  language: z.string().optional(),
  concept: z.array(ConceptSchema).default([]),
});

const BundleSchema = z.object({
  resourceType: z.literal("Bundle"),
  entry: z.array(z.object({ resource: z.unknown() })).default([]),
});

/**
 * Diagnosis-name CodeSystem (bare, or inside a Bundle; other resources ignored)
 * -> `{ language: { englishName: translated } }`. `{}` on empty input,
 * `undefined` when malformed.
 */
export function parseDiagnosisCodeSystem(
  parsed: unknown
): TranslationMapping | undefined {
  const bundle = BundleSchema.safeParse(parsed);
  const resources = bundle.success
    ? bundle.data.entry
        .map((e) => e.resource)
        .filter(
          (r) =>
            (r as { resourceType?: unknown } | null)?.resourceType ===
            "CodeSystem"
        )
    : [parsed ?? {}];
  const out: TranslationMapping = {};
  const walk = (concepts: Concept[], language: string | undefined) => {
    for (const c of concepts) {
      const names = namesOf(c, language);
      const en = names["en"];
      if (en)
        for (const [lang, value] of Object.entries(names))
          if (lang !== "en") (out[lang] ??= {})[en] = value;
      walk(c.concept ?? [], language);
    }
  };
  for (const resource of resources) {
    const cs = CodeSystemSchema.safeParse(resource);
    if (!cs.success) return undefined;
    walk(cs.data.concept, cs.data.language);
  }
  return out;
}
