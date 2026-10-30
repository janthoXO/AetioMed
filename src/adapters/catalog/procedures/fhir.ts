import z from "zod";
import {
  emptyTree,
  nodeKey,
  type ProcedureTree,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type { ReferenceBand } from "@/core/graph/shared/domain/Procedure.js";
import type { CatalogProcedure } from "@/core/graph/catalog/ports.js";
import type { TranslationMapping } from "../../persistence/translationStore.js";

// FHIR R4 subset: only the fields read below are validated; every other field
// and resource type in the Bundle is ignored.

type Concept = {
  code: string;
  display?: string | undefined;
  designation?: { language?: string | undefined; value: string }[] | undefined;
  property?: { code: string; valueBoolean?: boolean | undefined }[] | undefined;
  concept?: Concept[] | undefined;
};

const ConceptSchema: z.ZodType<Concept> = z.object({
  code: z.string().min(1),
  display: z.string().min(1).optional(),
  designation: z
    .array(
      z.object({ language: z.string().optional(), value: z.string().min(1) })
    )
    .optional(),
  property: z
    .array(z.object({ code: z.string(), valueBoolean: z.boolean().optional() }))
    .optional(),
  get concept() {
    return z.array(ConceptSchema).optional();
  },
});

const CodeSystemSchema = z.object({
  url: z.string().optional(),
  language: z.string().optional(),
  concept: z.array(ConceptSchema).default([]),
});

const QuantitySchema = z.object({
  value: z.number(),
  unit: z.string().optional(),
  code: z.string().optional(),
});

/** FHIR `Age` units (UCUM, value set `age-units`) in years; patient age is whole years. */
const YEARS_PER_UNIT: Record<string, number> = {
  a: 1,
  mo: 1 / 12,
  wk: 7 / 365.25,
  d: 1 / 365.25,
  h: 1 / 8766,
  min: 1 / 525960,
};

const AgeSchema = QuantitySchema.transform((q, ctx) => {
  const unit = q.code ?? q.unit ?? "a";
  const perYear = YEARS_PER_UNIT[unit];
  if (perYear === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `age unit "${unit}" is not a FHIR age unit (${Object.keys(YEARS_PER_UNIT).join(", ")})`,
    });
    return z.NEVER;
  }
  return q.value * perYear;
});

const ObservationDefinitionSchema = z.object({
  code: z.object({
    coding: z
      .array(z.object({ system: z.string().optional(), code: z.string() }))
      .default([]),
  }),
  quantitativeDetails: z
    .object({
      unit: z
        .object({
          coding: z.array(z.object({ code: z.string() })).optional(),
          text: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  qualifiedInterval: z
    .array(
      z.object({
        category: z.enum(["reference", "critical", "absolute"]).optional(),
        range: z
          .object({
            low: QuantitySchema.optional(),
            high: QuantitySchema.optional(),
          })
          .optional(),
        gender: z.enum(["male", "female", "other", "unknown"]).optional(),
        age: z
          .object({ low: AgeSchema.optional(), high: AgeSchema.optional() })
          .optional(),
      })
    )
    .default([]),
});

const BundleSchema = z.object({
  resourceType: z.literal("Bundle"),
  entry: z
    .array(z.object({ resource: z.looseObject({ resourceType: z.string() }) }))
    .default([]),
});

const ResourcesSchema = z.object({
  codeSystems: z.array(CodeSystemSchema),
  observationDefinitions: z.array(ObservationDefinitionSchema),
});

export type FhirCatalogue = {
  tree: ProcedureTree<CatalogProcedure>;
  /** Concept designations, `{ language: { nodeKey(englishPath): name } }`. */
  translations: TranslationMapping;
};

/**
 * A FHIR R4 `Bundle` as the procedure catalogue: every `CodeSystem`'s concepts
 * form the tree (a concept with child concepts is a category, a leaf is a
 * procedure unless `notSelectable`), designations its translations, and an
 * `ObservationDefinition` coded `system|code` gives that procedure its
 * reference bands. Empty input (missing file) is an empty catalogue. Throws
 * with the validation issues on anything else malformed.
 */
export function parseFhirCatalogue(parsed: unknown): FhirCatalogue {
  const catalogue: FhirCatalogue = { tree: emptyTree(), translations: {} };
  if (
    parsed === null ||
    parsed === undefined ||
    (typeof parsed === "object" && Object.keys(parsed).length === 0)
  )
    return catalogue;

  const bundle = BundleSchema.safeParse(parsed);
  if (!bundle.success) throw new Error(z.prettifyError(bundle.error));
  const resources = bundle.data.entry.map((e) => e.resource);
  const ofType = (type: string) =>
    resources.filter((r) => r.resourceType === type);
  const result = ResourcesSchema.safeParse({
    codeSystems: ofType("CodeSystem"),
    observationDefinitions: ofType("ObservationDefinition"),
  });
  if (!result.success) throw new Error(z.prettifyError(result.error));
  const { codeSystems, observationDefinitions } = result.data;

  const bandsByCoding = new Map<string, ReferenceBand[]>();
  for (const od of observationDefinitions) {
    const odUnit =
      od.quantitativeDetails?.unit?.coding?.[0]?.code ??
      od.quantitativeDetails?.unit?.text;
    const bands = od.qualifiedInterval.flatMap((i): ReferenceBand[] => {
      const { low, high } = i.range ?? {};
      if ((i.category ?? "reference") !== "reference" || (!low && !high))
        return [];
      const unit = low?.unit ?? low?.code ?? high?.unit ?? high?.code ?? odUnit;
      return [
        {
          ...(low && { low: low.value }),
          ...(high && { high: high.value }),
          ...(unit !== undefined && { unit }),
          ...(i.gender && { gender: i.gender }),
          ...(i.age && { age: i.age }),
        },
      ];
    });
    for (const c of od.code.coding)
      bandsByCoding.set(`${c.system ?? ""}|${c.code}`, bands);
  }

  for (const cs of codeSystems) {
    const sub = toTree(cs.concept, [], {
      language: cs.language,
      bandsOf: (code) => bandsByCoding.get(`${cs.url ?? ""}|${code}`),
      translations: catalogue.translations,
    });
    catalogue.tree.categories.push(...sub.categories);
    catalogue.tree.procedures.push(...sub.procedures);
  }
  return catalogue;
}

function toTree(
  concepts: Concept[],
  path: string[],
  cs: {
    language: string | undefined;
    bandsOf: (code: string) => ReferenceBand[] | undefined;
    translations: TranslationMapping;
  }
): ProcedureTree<CatalogProcedure> {
  const tree = emptyTree<CatalogProcedure>();
  for (const c of concepts) {
    const names = namesOf(c, cs.language);
    const name = names["en"] ?? c.display ?? c.code;
    const nodePath = [...path, name];
    for (const [language, value] of Object.entries(names))
      if (language !== "en")
        (cs.translations[language] ??= {})[nodeKey(nodePath)] = value;
    if (c.concept?.length) {
      tree.categories.push({ name, ...toTree(c.concept, nodePath, cs) });
    } else if (
      !c.property?.some((p) => p.code === "notSelectable" && p.valueBoolean)
    ) {
      const bands = cs.bandsOf(c.code);
      tree.procedures.push({
        name,
        code: c.code,
        ...(bands?.length && { bands }),
      });
    }
  }
  return tree;
}

/** Concept name per ISO 639-1 language: designations, then `display` in the CodeSystem's language. */
function namesOf(c: Concept, codeSystemLanguage: string | undefined) {
  const names: Record<string, string> = {};
  for (const d of c.designation ?? []) {
    const language = d.language?.split("-")[0];
    if (language) names[language] ??= d.value;
  }
  if (c.display) names[(codeSystemLanguage ?? "en").split("-")[0]!] = c.display;
  return names;
}
