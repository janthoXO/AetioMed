// Merge a modality-provider allow-list (CSV: code,provider) into an ILuVI FHIR procedure catalogue.
// Usage: pnpm catalog:providers <catalogue.fhir.json> <allowlist.csv> [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROP = "modalityProvider";
const DECLARATION = {
  code: PROP,
  type: "code",
  description:
    "Modality provider id allowed to render this procedure's result (AetioMed)",
};

type Pair = [code: string, provider: string];
type Prop = { code?: string; valueCode?: string };
type Concept = { code?: string; concept?: Concept[]; property?: Prop[] };
type Resource = {
  resourceType?: string;
  content?: string;
  concept?: Concept[];
  property?: Prop[];
};
type Bundle = { entry?: { resource?: Resource }[] };

export function parseAllowlistCsv(text: string): Pair[] {
  const pairs: Pair[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [code = "", provider = ""] = line.split(",").map((s) => s.trim());
    if (pairs.length === 0 && code === "code" && provider === "provider")
      continue;
    if (!code || !provider) throw new Error(`bad CSV line: "${line}"`);
    pairs.push([code, provider]);
  }
  return pairs;
}

function* concepts(cs: Resource): Generator<Concept> {
  const stack = [...(cs.concept ?? [])];
  while (stack.length) {
    const c = stack.shift()!;
    yield c;
    stack.unshift(...(c.concept ?? []));
  }
}

/** Mutates and returns `bundle`; on any error the caller must not write it. */
export function mergeAllowlist(
  bundle: Bundle,
  pairs: Pair[]
): { bundle: Bundle; errors: string[] } {
  const wanted = new Map<string, string[]>();
  for (const [code, provider] of pairs) {
    const list = wanted.get(code) ?? [];
    if (!list.includes(provider)) list.push(provider);
    wanted.set(code, list);
  }

  const errors: string[] = [];
  const found = new Map<string, number>();
  for (const { resource: cs } of bundle.entry ?? []) {
    if (cs?.resourceType !== "CodeSystem" || cs.content === "supplement")
      continue;
    let used = false;
    for (const c of concepts(cs)) {
      c.property = (c.property ?? []).filter((p) => p.code !== PROP);
      const providers = c.code === undefined ? undefined : wanted.get(c.code);
      if (c.code !== undefined && providers) {
        found.set(c.code, (found.get(c.code) ?? 0) + 1);
        if (c.concept?.length)
          errors.push(`${c.code}: not a leaf (has child concepts)`);
        else {
          c.property.push(
            ...providers.map((valueCode) => ({ code: PROP, valueCode }))
          );
          used = true;
        }
      }
      if (!c.property.length) delete c.property;
    }
    const rest = (cs.property ?? []).filter((p) => p.code !== PROP);
    if (used) rest.push(DECLARATION);
    if (rest.length) cs.property = rest;
    else delete cs.property;
  }

  const unknown = [...wanted.keys()].filter((c) => !found.has(c));
  if (unknown.length) errors.push(`unknown codes: ${unknown.join(", ")}`);
  for (const [c, n] of found)
    if (n > 1) errors.push(`${c}: ambiguous, found in ${n} places`);
  return { bundle, errors };
}

function main(): void {
  const [catalogue, csv, out] = process.argv.slice(2);
  if (!catalogue || !csv) {
    console.error(
      "usage: pnpm catalog:providers <catalogue.fhir.json> <allowlist.csv> [out.json]"
    );
    process.exit(1);
  }
  const pairs = parseAllowlistCsv(readFileSync(csv, "utf8"));
  const { bundle, errors } = mergeAllowlist(
    JSON.parse(readFileSync(catalogue, "utf8")) as Bundle,
    pairs
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  writeFileSync(out ?? catalogue, JSON.stringify(bundle, null, 2) + "\n");
  const counts: Record<string, number> = {};
  for (const pair of new Set(pairs.map((p) => p.join(",")))) {
    const provider = pair.split(",")[1]!;
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  const procs = new Set(pairs.map(([c]) => c)).size;
  console.log(
    `${procs} procedures, providers: ${Object.entries(counts)
      .map(([p, n]) => `${p} ×${n}`)
      .join(", ")}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
