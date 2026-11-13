type Json = Record<string, unknown>;

/**
 * Lossless rewrite of a JSON Schema into the subset every structured-output
 * provider accepts in strict mode (OpenAI, Gemini, Ollama/llama.cpp, Anthropic,
 * DeepSeek). The parsed result is unchanged — callers still validate it with
 * the original zod schema; this only shapes the grammar the model decodes with.
 *
 * - `const: v` → `enum: [v]` (Gemini does not list `const`)
 * - `oneOf` → `anyOf` (only `anyOf` is accepted everywhere; zod's
 *   discriminated unions have disjoint tags, so the two match the same values)
 * - object root required (OpenAI): anything else is wrapped as `{ value }`,
 *   and `unwrap` takes it back out of the model's answer
 * - every object closed with `additionalProperties: false` (OpenAI, Anthropic,
 *   DeepSeek); an open-keyed object (a record) throws instead — strict mode
 *   cannot express it, so an LLM schema must spell its keys out
 * - an optional property throws (OpenAI, DeepSeek strict need every property
 *   in `required`): use `.nullable()` in an LLM schema
 *
 * Provider-specific, lossy rewrites (dropping bounds a provider rejects) do
 * not belong here; they go with that provider in `getLLM`.
 */
export function portableSchema(schema: Json): {
  schema: Json;
  unwrap: (result: unknown) => unknown;
} {
  const root = { ...schema };
  delete root.$schema;
  const isObjectRoot =
    root.type === "object" && !("anyOf" in root) && !("oneOf" in root);
  if (isObjectRoot) {
    return { schema: rewrite(root, "(root)"), unwrap: (r) => r };
  }
  // `#/$defs/...` refs resolve against the root, so defs stay on the wrapper.
  const { $defs, definitions, ...value } = root;
  return {
    schema: rewrite(
      {
        type: "object",
        properties: { value },
        required: ["value"],
        additionalProperties: false,
        ...($defs ? { $defs } : {}),
        ...(definitions ? { definitions } : {}),
      },
      "(root)"
    ),
    unwrap: (r) => (r as { value?: unknown } | undefined)?.value,
  };
}

function rewrite(node: Json, path: string): Json {
  const out: Json = { ...node };

  if ("const" in out) {
    out.enum = [out.const];
    delete out.const;
  }
  if ("oneOf" in out) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }

  if (out.type === "object" || "properties" in out) {
    if (
      "propertyNames" in out ||
      "patternProperties" in out ||
      (out.additionalProperties !== undefined &&
        out.additionalProperties !== false)
    ) {
      throw new Error(
        `LLM output schema has an open-keyed object (record) at ${path}; strict structured output needs every key spelled out — build a z.object from the known keys`
      );
    }
    out.additionalProperties = false;
    const required = new Set((out.required as string[] | undefined) ?? []);
    const optional = Object.keys(out.properties ?? {}).filter(
      (k) => !required.has(k)
    );
    if (optional.length > 0) {
      throw new Error(
        `LLM output schema has optional field(s) ${optional.join(", ")} at ${path}; strict structured output needs every property required — use .nullable() instead of .optional()`
      );
    }
    if (out.properties) {
      out.properties = Object.fromEntries(
        Object.entries(out.properties as Record<string, Json>).map(([k, v]) => [
          k,
          rewrite(v, `${path}.${k}`),
        ])
      );
    }
  }

  if (out.items) out.items = rewrite(out.items as Json, `${path}[]`);
  if (out.anyOf) {
    out.anyOf = (out.anyOf as Json[]).map((s, i) => rewrite(s, `${path}|${i}`));
  }
  for (const defs of ["$defs", "definitions"] as const) {
    if (out[defs]) {
      out[defs] = Object.fromEntries(
        Object.entries(out[defs] as Record<string, Json>).map(([k, v]) => [
          k,
          rewrite(v, `${defs}.${k}`),
        ])
      );
    }
  }
  return out;
}
