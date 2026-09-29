import z from "zod";
import { nodeKey } from "@/core/graph/models/ProcedureTree.js";
import type { TranslationMapping } from "../../persistence/translationStore.js";

const LeafTranslationSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
});

type CategoryTranslation = z.infer<typeof LeafTranslationSchema> & {
  categories?: CategoryTranslation[] | undefined;
  procedures?: z.infer<typeof LeafTranslationSchema>[] | undefined;
};

const CategoryTranslationSchema: z.ZodType<CategoryTranslation> =
  LeafTranslationSchema.extend({
    get categories() {
      return z.array(CategoryTranslationSchema).optional();
    },
    procedures: z.array(LeafTranslationSchema).optional(),
  });

const TreeTranslationSchema = z.object({
  categories: z.array(CategoryTranslationSchema).optional(),
  procedures: z.array(LeafTranslationSchema).optional(),
});

/** `{ Language: tree }`; each node's `key` is its English name, `name` its translation. */
const ProcedureTranslationFileSchema = z.partialRecord(
  z.string(),
  TreeTranslationSchema
);

/**
 * `proceduresTranslations.yml` flattened to the translation store's shape:
 * `{ Language: { nodeKey(englishPath): translatedName } }`. Every node, category
 * or procedure, gets one entry for its own segment. Whether each key path
 * exists in the English tree is startup validation's job. `undefined` if
 * malformed.
 */
export function flattenProcedureTranslations(
  parsed: unknown
): TranslationMapping | undefined {
  const result = ProcedureTranslationFileSchema.safeParse(parsed);
  if (!result.success) return undefined;
  return Object.fromEntries(
    Object.entries(result.data).map(([language, tree]) => {
      const byKey: Record<string, string> = {};
      if (tree) flatten(tree, [], byKey);
      return [language, byKey];
    })
  );
}

function flatten(
  tree: z.infer<typeof TreeTranslationSchema>,
  path: string[],
  out: Record<string, string>
) {
  for (const leaf of tree.procedures ?? []) {
    out[nodeKey([...path, leaf.key])] = leaf.name;
  }
  for (const category of tree.categories ?? []) {
    const categoryPath = [...path, category.key];
    out[nodeKey(categoryPath)] = category.name;
    flatten(category, categoryPath, out);
  }
}
