# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # run with tsx watch (auto-restart, loads .env)
pnpm build        # tsc + tsc-alias
pnpm start        # run compiled dist/index.js
pnpm test         # vitest run
pnpm test:watch   # vitest
pnpm lint         # eslint
pnpm lint:fix     # eslint --fix
pnpm format       # prettier --write src (markdown, package.json, workflows and scripts/ are not covered)
pnpm format:check # prettier --check src
pnpm graph:export # export LangGraph diagrams as SVGs (src/core/graph/02graphs/exportGraphs.ts)
pnpm db:generate  # drizzle-kit generate — regenerate SQL migrations in drizzle/
pnpm translations:generated  # list LLM-generated translation rows for review
```

`pnpm format`/`format:check` only cover `src` — markdown, `package.json`, the workflows and
`scripts/` are not format-checked. Format those manually with
`npx prettier --write <path>` when touched.

### Infrastructure

```bash
docker compose up --build                    # server + ollama (NATS via profile)
docker compose --profile NATS up -d          # infrastructure only, then run pnpm dev locally
```

`nats`/`nats-box` are behind the `NATS` compose profile. The `PERSISTENCY` profile's
`redis` service is left over from the removed persistency module and is no longer used by
the server.

### Graph diagram generation (requires Chrome via Puppeteer)

```bash
pnpm exec puppeteer browsers install chrome
pnpm graph:export
```

## Architecture

This is a backend-only repository (no frontend lives here). Node >= 22.5, pnpm.

### Composition Root

There is no plugin/extension framework — `createApp()` in `src/core/app.ts` constructs
everything explicitly, in order:

1. parses `FEATURES` and the graph config from `process.env`
2. resolves `CATALOG_DIR` / `CACHE_DIR` (`persistence/paths.ts` — pure functions taking the
   environment as an argument; nothing under `src/core/graph/` reads `process.env`)
3. `initGraph()` builds the repos (`repos.ts`'s `createRepos`), the `GraphRuntime`, and the
   compiled graph, then validates the catalogues
4. `createCaseGenerationService(graph, bus)`
5. starts the transports whose flags are set

**`GraphRuntime`** (`src/core/graph/runtime.ts`) is the single seam graph construction goes
through: the LLM port, the four catalogs, a logger and a clock. It is captured by **closure
at graph-assembly time**, not threaded through node signatures and not carried on
LangGraph's runtime context. Nothing under `src/core/graph/` imports a mutable module
singleton.

**`CaseGenerationService`** (`src/core/caseGenerationService.ts`) is what both transports
call. It owns ICD→name resolution, jobId minting, `runWithContext`, terminal event emission
(`Generation Completed` / `Failure` / `Cancelled`) and error→status mapping, and returns a
job shape (`{ jobId, status, case?, error? }`) rather than a bare `Case`. Transports are
protocol translation only.

**Modules under `src/transports/` and `src/tracing/`** are ordinary modules with a start
function, not plugins: `transports/rest/` (`startRestServer`), `transports/nats/`
(`startNatsTransport`), `tracing/` (`wireTracing`, which registers a job hook on the
core-owned registry in `utils/context.ts`) and `tracing/sse/` (SSE streaming, mounted onto
the Express app built by `transports/rest/` — it still depends on `rest/`, which is fine and
unchanged). `src/api/` holds the shared request/response Zod schemas.

The typed **`EventBus`** (`src/core/event-bus.ts`) is kept — it genuinely decouples tracing
from the graph. Modules augment its `EventMap` interface via TypeScript module
augmentation.

### Catalog Layer

`src/core/graph/catalog/` owns the catalogue concept behind ports (`ProcedureCatalog`,
`AnamnesisCatalog`, `LabelCatalog`, `DiagnosisCatalog` in `ports.ts`). Each domain is its own
vertical slice — `catalog/<domain>/` (`procedures/`, `anamnesis/`, `labels/`, `diagnosis/`) —
holding both that domain's repo (`repo.ts`) and its port adapters (`catalog.ts`: a `Yaml*`
adapter over the repo instance and an `InMemory*` adapter for tests), re-exported from the
slice's `index.ts`. `catalog/index.ts` composes all four `Yaml*` adapters into the
`GraphRuntime["catalogs"]` bundle (`createYamlCatalogs(repos)`) from an already-constructed
`Repos` (see `repos.ts` below).

`procedures/index.ts` and `anamnesis/index.ts` export their repo alongside their catalog —
not just the port adapter — because the from-English translation graph
(`02graphs/03case-translation-from-english/`) and `02graphs/exportGraphs.ts` still bypass the
`ProcedureCatalog`/`AnamnesisCatalog` port to reach translation accessors
(`getProcedureNameTranslationFromEnglish`/`saveProcedureNameTranslation`,
`getAnamnesisCategoryTranslationFromEnglish`/`saveAnamnesisCategoryTranslations`) that the
port doesn't expose. `labels/` and `diagnosis/` export their repo too, but only so the
composition root can construct it — no other module reaches past their port. Issue #89
collapses this to a single entry point.

`ProcedureCandidates` (`catalog/procedures/candidates.ts`) is where flat-vs-grouped
presentation, category scoping, exclusion of already-ordered procedures, the literal-union
grammar and `"Category: Name"` reassembly live — the AI gateway only calls `render()`,
`grammar()` and `assemble()`.

`startupValidation.ts` checks every translation file against its base catalogue at startup
and exits non-zero naming every offending key, with a Levenshtein suggestion. **Diagnosis is
exempt** — its store is also an input index for user-supplied diagnosis names, so keys
outside the curated catalogue are legitimate. Validation runs after graph construction
because the labels catalogue's base key set is `getKnownLabels()`, populated by `traceNode`
as the graph is built.

### Case Generation Pipeline (LangGraph)

All AI generation uses LangGraph. Graphs live in `src/core/graph/02graphs/`. The top-level graph (`caseGraph.ts`) sequences three subgraphs, skipping translation when the language is English:

1. **`01case-translation-to-english/`** — translates the input diagnosis to English
2. **`02case-generation/`** — the core generation pipeline (see below)
3. **`03case-translation-from-english/`** — fans out via `Send` to translate anamnesis categories / procedure names, then translates values back to the target language

`generateCase(diagnosis, generationFlags, userInstructions?, language?, difficulty?)` invokes the top-level graph with a runtime context carrying `jobId`, `llmConfig`, `language`, and an abort `signal`.

The **`caseGenerationGraph`** (`02case-generation/index.ts`) runs three phases:

- **`01symptom/`** — always runs first; combines a static UMLS symptom floor (per ICD code) with cache-aside LLM-generated additions (skips the LLM on a fresh cache hit)
- **`02presentation/`** — `generation/` generates a detailed case outline (the complete factual record of the case), then a combined outline evaluate ⇄ revise `Command` loop (max 2 iterations) judging obviousness AND clinical consistency in one LLM call; once accepted, fans out via `Send` to `patient_generate` / `chief_complaint_generate` / `anamnesis_generate` (gated per `generationFlags`) which only render the outline's facts in the right voice/format, joining at `case_fan_in`. There is no post-fan-out consistency check.
- **`03procedure/`** — only when the `procedures` flag is set. A **blinded solver** loop (max 6 iterations) with exactly 3 nodes: `blinded_step` orders procedures without knowing the true diagnosis, `result_step` generates their results non-blinded; when the solver commits to a diagnosis, an LLM judge checks the match (loop continues with `ruledOutDiagnoses` on mismatch). On exhaustion, a `bridge` node generates confirmatory procedures for the true diagnosis. The approved procedure list is presented (and picked) grouped by category (`{ "Category": ["Name", …] }`, with uncategorized procedures under a synthetic `"General"` bucket) rather than as one flat list — this applies to both the blinded pick and the (non-blinded) bridge pick, the latter grouping full `{name, relevance, result}` objects per category. When `LLM_SMALL` is set and the list has real categories, `blinded_step` and `bridge` each split their single LLM call into two sequential tool calls **inside the same node** (a category-only pick, over-inclusive, followed by a procedure/results-only pick scoped to those categories plus `"General"`) rather than adding separate graph nodes — the graph shape stays fixed at 3 nodes regardless of `LLM_SMALL`. The blinded scoped pick may answer with an `expand` action requesting additional categories: a bounded loop in `resolveBlindedStepViaCategories` unions them into a local scope set and retries (max 2 expansions per `blinded_step`; the expand grammar only admits categories not yet in scope, and past the cap the branch is removed from the schema entirely — the visited set lives in code, never the model). The bridge's scoped pick instead retries deterministically once with all categories if it returns empty. Additional guards: already-ordered procedures are excluded from every candidate list/grammar (duplicate orders are impossible by construction), category-pick prompts show per-category counts plus sample names, and blinded prompts include the remaining iteration budget as convergence pressure.

**Tool pattern:** each subgraph directory has a `tools.ts` exporting `Tool<TInput, TOutput>` objects (`src/core/graph/utils/tool.ts`). Graph nodes are thin — prompt building, LLM calls, retries, and structured-output parsing live in the aigateway behind the tools. Nodes are wrapped with `traceNode()` (`utils/nodeWrapper.ts`) to emit "Node Started/Completed" bus events with translated labels.

**Generation flags** (`src/core/graph/models/GenerationFlags.ts`): `patient`, `chiefComplaint`, `anamnesis`, `procedures`. Requests also carry a **difficulty** (`models/Difficulty.ts`: `easy | medium | hard`, default `medium`).

### AI Gateway Layer

`src/core/graph/03aigateway/` contains one file per generated field (case, symptoms, patient, chiefComplaint, anamnesis, outlineEvaluation, procedures, diagnosis, labels, plus `translate.helper.ts`). Each gateway builds prompts, calls `runtime.llm.for({ role, temperature }, context?.llmConfig)` (from `src/core/graph/runtime.ts`, implemented in `src/core/graph/utils/llm.ts`), and wraps calls with `retry()`.

**LLM roles** (`LlmPort.for`, `src/core/graph/runtime.ts`) model two independent dimensions per call: `role` (`generator` | `judge` | `translator` — each independently configurable, e.g. a small local model generating against a stronger judge) and `temperature` (a fixed policy class, not configuration: `deterministic` = 0.1, `balanced` = 0.4, `creative` = 0.7, read from `utils/llm.ts`). Every call site's role/temperature pairing is fixed by what it does, not by config. Judges (`outlineEvaluation.aigateway.ts`, `matchDiagnosis` in `procedures.aigateway.ts`) and translators (`diagnosis.aigateway.ts`, `translate.helper.ts`, the from-English translation tools) are the two roles that diverge from `generator`, which is everything else, including `generateSymptomsOneShot` (clinical content generation, not translation).

The underlying adapter supports three providers: `ollama`, `google`, `openai` (the `openai` provider also serves OpenAI-compatible endpoints via `LLM_URL`). Provider/model come from env — a general `LLM_PROVIDER`/`LLM_MODEL` plus optional per-role `LLM_GENERATOR_*`/`LLM_JUDGE_*`/`LLM_TRANSLATOR_*` overrides, each field falling back individually to the general value — or from a per-request `llmConfig` passed via `RequestContext` (AsyncLocalStorage), which applies uniformly to all three roles. The `ALLOW_LLMS` feature flag enables per-request LLM selection from an allowlist (`ALLOWED_LLMS=ollama:llama3.1,google:gemini-2.0-flash`); when set, no global LLM (and no per-role default) is configured and requests must supply `llmConfig` (exposed via `GET /api/allowedLlms`). Temperature is never part of `llmConfig`'s effective behavior — it is always the call site's fixed class.

### Repo Layer (embedded SQLite via Drizzle)

The data layer is organized as vertical slices rather than one `repo/` directory. Shared
SQLite infrastructure lives in `src/core/graph/persistence/`; each catalogue domain's repo
lives inside its own slice under `src/core/graph/catalog/<domain>/repo.ts`; the symptoms
cache is its own slice, `src/core/graph/symptoms/`; and `src/core/graph/repos.ts` composes
all of them into one `Repos` bundle. All of it backs lookups/caches with an embedded SQLite
DB at `data/cache/aetiomed.db` (`node:sqlite`, WAL; Drizzle ORM, migrations in `drizzle/`,
config in `drizzle.config.ts`).

**Every repo module exports a `createXxx(...)` factory and performs no I/O on import** —
`src/core/graph/repos.test.ts` enforces that by importing `persistence/db.ts`, every
`catalog/<domain>/repo.ts`, `symptoms/repo.ts` and `repos.ts` itself and asserting neither
`fs.mkdirSync` nor a catalogue-file `fs.readFileSync` fired. `createRepos()` in `repos.ts`
constructs them once, from `createApp()`.

`src/core/graph/persistence/`:

- `db.ts` — `createDb(cacheDir)` opens the DB and runs migrations; `syncSource()` re-ingests a YAML file only when its sha256 changed (fingerprints in `_meta`, keyed on the domain name so moving `CATALOG_DIR` does not invalidate the cache)
- `schema.ts` — tables: `_meta`, `translation`, `diagnosis`, `predefined_item`, `symptom_cache`
- `translationStore.ts` — cache-aside translation store used by diagnosis, procedures, anamnesis categories and trace labels. In-flight work is deduped **per key**; retries live inside the shared promise; runtime fills insert-if-absent and read back (first-writer-wins), while a YAML sync overwrites. `source` marks a row `curated` or `generated`; generated values persist in the DB, never back into YAML
- `paths.ts` — `resolveCatalogDir`/`resolveCacheDir` (`CATALOG_DIR`/`CACHE_DIR` resolution) and `catalogFile()`
- `predefinedList.ts` — reads a translations YAML file directly (bypassing `syncSource`'s hash cache) for startup validation

`src/core/graph/catalog/<domain>/repo.ts` (`diagnosis/`, `procedures/`, `anamnesis/`,
`labels/`) — each syncs its YAML source(s) and exposes lookups. **Catalogue lists are
language-independent**; only the translation accessors take a language.

`src/core/graph/symptoms/repo.ts` — static UMLS floor from `diagnosis_symptoms.json` + LLM-symptom cache with TTL (`SYMPTOM_CACHE_TTL_DAYS`)

### Numbered Directory Convention

`src/core/graph/` uses numbered prefixes to indicate layer order:

- `02graphs/` — LangGraph graphs (subgraph directories are themselves numbered by phase)
- `03aigateway/` — LLM prompt/call functions

`02graphs/` and `03aigateway/` keep their numbers because the numbers encode pipeline order —
graphs call into the gateway, not the reverse. There used to be a `03repo/` alongside them;
it is gone, deliberately unnumbered in its replacement (`persistence/`, `catalog/<domain>/`,
`symptoms/`, `repos.ts`) rather than renumbered, because `03repo/` was a layer _label_, not a
pipeline step, and that layer no longer exists as one directory — the number would no longer
mean anything. Read the inconsistency as a decision, not an oversight.

Plus unnumbered `catalog/`, `persistence/`, `symptoms/`, `repos.ts`, `models/` (Zod domain
models), `utils/`, `errors/`, `config.ts`.

### REST Layer

`src/transports/rest/` (requires the `REST` feature flag). Routes translate protocol only —
generation goes through `CaseGenerationService`:

- `GET /api/health`, `GET /api/features`, `GET /api/allowedLlms`
- `routes/cases.router.ts` — `POST /api/cases` (aborts on client disconnect), `DELETE /api/cases/:jobId` (cancel)
- `routes/diagnosis.router.ts` — `GET /api/diagnosis`
- `routes/procedures.router.ts` — `GET /api/procedures`
- `src/tracing/sse/` — `GET /api/traces/:jobId/stream` (SSE), mounted onto the REST app when `TRACING` is set

### Data Files

`CATALOG_DIR` (default `data/`) contains the files synced into the SQLite cache at startup
(only re-parsed when changed). Paths below are relative to it:

- `procedures.yml` / `proceduresTranslations.yml` — predefined procedure names (when set, LLM must select from this list only)
- `diagnosis.yml` / `diagnosisTranslations.yml` — ICD-11 diagnosis lookup
- `anamnesisCategories.yml` / `anamnesisCategoriesTranslations.yml` — anamnesis section definitions (static config, no longer a request field)
- `labelTranslations.yml` — trace-node label translations
- `diagnosis_symptoms.json` — UMLS-derived symptom floor per ICD code (loaded directly, not via the DB sync)
  The embedded SQLite DB is generated under `CACHE_DIR` (default `data/cache/`), which is
  deliberately a separate directory so a deployer can mount their own catalogues over
  `CATALOG_DIR` without clobbering it.

`scripts/extract-icd11*.ts` build the diagnosis YAML files from ICD-11 source data (run manually).

### Request Context

`runWithContext(fn, jobId?, llmConfig?, language?)` in `src/core/graph/utils/context.ts` uses `AsyncLocalStorage` to propagate `jobId`, optional `llmConfig` and an abort `signal` through the entire async call chain, and registers an `AbortController` with `cancelManager` (`utils/cancelManager.ts`) so generations can be cancelled by jobId. Graph nodes access it via `runtime?.context` (LangGraph passes `RequestContextSchema` as the runtime context schema) or `getRequestContext()`.

Core does not import the tracing module: `registerJobHook()` is a core-owned registry the
`tracing` module registers against. With `TRACING` unset nothing is registered and no
per-job trace bus is allocated.

## Environment Variables

| Variable                                                   | Default                 | Notes                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                     | `3030`                  | Server port                                                                                                                                   |
| `FEATURES`                                                 | `""`                    | Comma-separated flags: `REST`, `NATS`, `TRACING`, `ALLOW_LLMS`                                                                                |
| `LLM_PROVIDER`                                             | —                       | `ollama` \| `google` \| `openai` (required unless `ALLOW_LLMS`)                                                                               |
| `LLM_MODEL`                                                | —                       | Model name (required unless `ALLOW_LLMS`)                                                                                                     |
| `LLM_API_KEY`                                              | —                       | API key for Google/OpenAI                                                                                                                     |
| `LLM_URL`                                                  | —                       | Override base URL (e.g. local Ollama or OpenAI-compatible endpoints)                                                                          |
| `LLM_GENERATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`  | —                       | Optional per-field override for the `generator` role; unset fields fall back to the general `LLM_*` value                                     |
| `LLM_JUDGE_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`      | —                       | Optional per-field override for the `judge` role (same per-field fallback)                                                                    |
| `LLM_TRANSLATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL` | —                       | Optional per-field override for the `translator` role (same per-field fallback)                                                               |
| `LLM_SMALL`                                                | `false`                 | `true`/`1` enables small-model-friendly prompting (e.g. splits the blinded procedure step into a category pick then a procedure pick)         |
| `ALLOWED_LLMS`                                             | —                       | Format: `ollama:model1,google:model2` (requires `ALLOW_LLMS` flag)                                                                            |
| `CATALOG_DIR`                                              | `data`                  | Deployer-owned, read-only catalogue inputs (YAML/JSON config files); resolved absolute against `process.cwd()` when relative                  |
| `CACHE_DIR`                                                | `data/cache`            | Generated, writable output — the embedded SQLite database (`aetiomed.db`) lives here; resolved absolute against `process.cwd()` when relative |
| `NATS_URL`                                                 | `nats://localhost:4222` | `nats://nats:4222` in docker compose                                                                                                          |
| `NATS_USER` / `NATS_PASSWORD`                              | `nats` / `nats`         |                                                                                                                                               |
| `SYMPTOM_CACHE_TTL_DAYS`                                   | `30`                    | TTL for cached LLM-generated symptoms (see `symptoms/repo.ts`)                                                                                |

Note: the `REST` flag is required for the HTTP API to load — include it in `FEATURES` when running the server.

## Path Aliases

`@/*` → `src/*` (configured in `tsconfig.json`; resolved at runtime by `tsx`, at build time by `tsc-alias`).
