// Experiment: web search for the outline, as a medical-basis provider vs. as an
// agent tool, against today's baseline. Writes JSON to the path in argv[2].
// Run: pnpm exec tsx --env-file=.env scripts/compare-outline-websearch.ts out.json
import fs from "node:fs";
import z from "zod";
import { ConfigSchema } from "@/core/graph/index.js";
import {
  resolveCacheDir,
  resolveCatalogDir,
} from "@/adapters/persistence/paths.js";
import { createRepos } from "@/adapters/repos.js";
import { createYamlCatalogs } from "@/adapters/catalog/index.js";
import { createLlmPort } from "@/adapters/ai/llm.js";
import { createOllamaWebSearch } from "@/adapters/search/ollamaWebSearch.js";
import {
  createMedicalBasisRegistry,
  resolveAllFragments,
  type BasisFragment,
} from "@/core/graph/02-plan/01-basis/index.js";
import { createWebSearchProvider } from "@/core/graph/02-plan/01-basis/providers/webSearch.js";
import {
  evaluateOutline,
  generateCaseOutline,
} from "@/core/graph/02-plan/02-outline/gateway.js";
import { joinOutline } from "@/core/graph/shared/outline/segments.js";
import type { GraphRuntime, WebSearch } from "@/core/graph/runtime.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import type { Difficulty } from "@/core/graph/shared/domain/Difficulty.js";
import { renderSchemaForPrompt } from "@/core/graph/shared/prompt/prompt.js";

const DIAGNOSES: Diagnosis[] = [
  { name: "Celiac disease", icd: "K90.0" },
  { name: "Wilson disease", icd: "E83.01" },
  { name: "Sarcoidosis", icd: "D86.9" },
  { name: "Pulmonary tuberculosis", icd: "A15.0" },
  { name: "Pulmonary embolism", icd: "I26.99" },
  { name: "Addison disease", icd: "E27.1" },
];
const DIFFICULTY: Difficulty = "medium";
const VARIANTS = ["baseline", "basis", "agent"] as const;
type Variant = (typeof VARIANTS)[number];

const out = process.argv[2] ?? "outline-websearch.json";
const config = ConfigSchema.parse(process.env);
const repos = createRepos({
  catalogDir: resolveCatalogDir(process.env),
  cacheDir: resolveCacheDir(process.env),
  symptomCacheTtlDays: 30,
});
const runtime: GraphRuntime = {
  llm: createLlmPort(config),
  catalogs: createYamlCatalogs(repos),
  log: { info: console.log, warn: console.warn, error: console.error },
  clock: () => new Date(),
};
const search = createOllamaWebSearch({ apiKey: process.env.LLM_API_KEY! });
const baseRegistry = createMedicalBasisRegistry({
  runtime,
  umlsFloor: repos.umlsFloor,
  symptomCache: repos.symptomCache,
});

/** Records every query a variant sends. */
function recording(queries: string[]): WebSearch {
  return (query, context) => {
    queries.push(query);
    return search(query, context);
  };
}

const CRITERIA = [
  "accuracy",
  "specificity",
  "difficulty",
  "coherence",
] as const;
const Scores = z.object(
  Object.fromEntries(CRITERIA.map((c) => [c, z.number().int().min(1).max(5)]))
);
const VerdictSchema = z.object({
  scoresA: Scores,
  scoresB: Scores,
  winner: z.enum(["A", "B", "tie"]),
  rationale: z.string(),
});

async function judge(diagnosis: Diagnosis, a: string, b: string) {
  return runtime.llm.structured(
    { role: "judge", temperature: "deterministic" },
    {
      system: `You are a senior physician and medical educator comparing two blueprints (A and B) for the same clinical training case. Score each 1-5 on:
- accuracy: are the clinical facts (symptoms, epidemiology, lab values, imaging, workup) medically correct for the diagnosis? Penalize any error or implausible value hard.
- specificity: concrete, realistic values (exact lab numbers with units, named findings) rather than vague descriptions.
- difficulty: fits "${DIFFICULTY}" difficulty — some deduction needed, 1-2 plausible distractors, diagnosis never named.
- coherence: sections consistent with each other and with the patient.
Then pick the overall better blueprint as a clinician would use it for teaching, or "tie". Length is not quality.

Return ONLY a valid JSON object:
${renderSchemaForPrompt(VerdictSchema)}`,
      user: `Target diagnosis: ${diagnosis.name} (${diagnosis.icd})\n\n=== Blueprint A ===\n${a}\n\n=== Blueprint B ===\n${b}`,
    },
    VerdictSchema
  );
}

type Run = {
  variant: Variant;
  outline: string;
  ms: number;
  queries: string[];
  basisChars: number;
  accepted: boolean;
  reasons: string[];
  error?: string;
};

async function runVariant(
  variant: Variant,
  diagnosis: Diagnosis,
  baseFragments: BasisFragment[]
): Promise<Run> {
  const queries: string[] = [];
  const webSearch = recording(queries);
  const started = Date.now();
  try {
    const fragments =
      variant === "basis"
        ? await resolveAllFragments(
            [...baseRegistry, createWebSearchProvider(webSearch)],
            { diagnosis, difficulty: DIFFICULTY },
            runtime.log
          )
        : baseFragments;
    const segments = await generateCaseOutline(
      runtime,
      diagnosis,
      fragments,
      DIFFICULTY,
      variant === "agent" ? { webSearch } : {}
    );
    const ms = Date.now() - started;
    const outline = joinOutline(segments);
    const evaluation = await evaluateOutline(
      runtime,
      diagnosis,
      outline,
      DIFFICULTY
    );
    return {
      variant,
      outline,
      ms,
      queries,
      basisChars: fragments.reduce((n, f) => n + f.content.length, 0),
      accepted: evaluation.accepted,
      reasons: evaluation.reasons,
    };
  } catch (error) {
    return {
      variant,
      outline: "",
      ms: Date.now() - started,
      queries,
      basisChars: 0,
      accepted: false,
      reasons: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const PAIRS: [Variant, Variant][] = [
  ["basis", "agent"],
  ["baseline", "basis"],
  ["baseline", "agent"],
];

const results = [];
for (const diagnosis of DIAGNOSES) {
  console.log(`\n=== ${diagnosis.name} ===`);
  const baseFragments = await resolveAllFragments(
    baseRegistry,
    { diagnosis, difficulty: DIFFICULTY },
    runtime.log
  );
  const runs = await Promise.all(
    VARIANTS.map((v) => runVariant(v, diagnosis, baseFragments))
  );
  const byVariant = Object.fromEntries(runs.map((r) => [r.variant, r]));

  // Each pair judged in both orders to cancel position bias.
  const comparisons = await Promise.all(
    PAIRS.filter(([x, y]) => byVariant[x]!.outline && byVariant[y]!.outline)
      .flatMap(([x, y]) => [
        [x, y],
        [y, x],
      ])
      .map(async ([a, b]) => ({
        a,
        b,
        verdict: await judge(
          diagnosis,
          byVariant[a!]!.outline,
          byVariant[b!]!.outline
        ).catch((e: Error) => ({ error: e.message })),
      }))
  );

  results.push({ diagnosis, runs, comparisons });
  for (const r of runs)
    console.log(
      `${r.variant.padEnd(8)} ${String(r.ms).padStart(6)}ms accepted=${r.accepted} queries=${r.queries.length}${r.error ? ` ERROR ${r.error}` : ""}`
    );
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
}
console.log(`\nWrote ${out}`);
