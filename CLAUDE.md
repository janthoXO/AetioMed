# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # generate registry + run with tsx watch (auto-restart, loads .env)
pnpm build        # generate registry + tsc + tsc-alias
pnpm start        # run compiled dist/index.js
pnpm lint         # eslint
pnpm lint:fix     # eslint --fix
pnpm format       # prettier --write
pnpm graph:export # export LangGraph diagrams as SVGs (src/core/graph/02graphs/exportGraphs.ts)
pnpm swagger      # regenerate swagger-output.json
pnpm generate     # regenerate src/extensions/_registry.ts (runs automatically in dev/build)
pnpm db:generate  # drizzle-kit generate — regenerate SQL migrations in drizzle/
```

### Infrastructure

```bash
docker compose up --build                                      # server + ollama (NATS/Redis via profiles)
docker compose --profile NATS --profile PERSISTENCY up -d      # infrastructure only, then run pnpm dev locally
```

`nats`/`nats-box` are behind the `NATS` compose profile; `redis` behind `PERSISTENCY`.

### Graph diagram generation (requires Chrome via Puppeteer)

```bash
pnpm exec puppeteer browsers install chrome
pnpm graph:export
```

## Architecture

This is a backend-only repository (no frontend lives here). Node >= 22.5, pnpm.

### Extension System

The server is built around a **plugin/extension architecture**. Extensions live in `src/extensions/` and are auto-discovered by `scripts/generate-registry.ts`, which writes `src/extensions/_registry.ts` (never edit this file manually). Each extension is defined via `defineExtension()` from `src/core/extension.ts`.

Key properties of each extension:

- `requiredFlags`: feature flags (from `FEATURES` env var) that must be set for the extension to load
- `dependsOn`: other extensions this one requires; the loader (`src/core/loader.ts`) topologically sorts and cascade-skips
- `envSchema`: a Zod schema that parses its own slice of `process.env`
- `setup(ctx)`: async initialization; receives `ctx.config`, `ctx.bus`, and `ctx.dep(otherExt)`

Extensions communicate via a typed `EventBus` (`src/core/event-bus.ts`). Extensions augment the `EventMap` interface via TypeScript module augmentation to declare their events.

**Currently registered extensions:**
| Extension | Required Flags | Depends On | Purpose |
|---|---|---|---|
| `api` | none | — | Shared request/response Zod schemas (`CaseGenerationRequest/Response`, `ErrorResponse`) |
| `debugLogger` | `DEBUG` | — | Logs bus events to console |
| `nats` | `NATS` | `api` | Async case generation via NATS JetStream (`cases.generate`, cancel via `cases.cancel.>`) |
| `persistency` | `PERSISTENCY` | `rest` | Saves completed cases to Redis; mounts its router |
| `rest` | `REST` | `api` | Express HTTP server; exports the shared `apiRouter` mounted at `/api` |
| `swagger` | none | `rest` | Serves Swagger UI |
| `tracing` | `TRACING` | — | Bridges bus lifecycle events to per-job trace buses (`traceManager.ts`) |
| `tracingNats` | none | `tracing`, `nats` | Republishes trace events to NATS (`cases.traces.${jobId}`) |
| `tracingPersistency` | none | `rest`, `persistency`, `tracing` | Persists trace logs to Redis (`traces:${jobId}`, 24h TTL) |
| `tracingRest` | none | `tracing`, `rest` | SSE live trace streaming: `GET /traces/:jobId/stream` |

To add a new extension: create `src/extensions/<name>/index.ts` exporting `extension`. The registry regenerates automatically on `pnpm dev` or `pnpm build`.

The case-generation graph itself is **not** an extension: it lives in `src/core/graph/` and is initialized directly by `createApp()` in `src/core/app.ts` via `initGraph()`.

### Case Generation Pipeline (LangGraph)

All AI generation uses LangGraph. Graphs live in `src/core/graph/02graphs/`. The top-level graph (`caseGraph.ts`) sequences three subgraphs, skipping translation when the language is English:

1. **`01case-translation-to-english/`** — translates the input diagnosis to English
2. **`02case-generation/`** — the core generation pipeline (see below)
3. **`03case-translation-from-english/`** — fans out via `Send` to translate anamnesis categories / procedure names, then translates values back to the target language

`generateCase(diagnosis, generationFlags, userInstructions?, language?, difficulty?)` invokes the top-level graph with a runtime context carrying `jobId`, `llmConfig`, `language`, and an abort `signal`.

The **`caseGenerationGraph`** (`02case-generation/index.ts`) runs three phases:

- **`01symptom/`** — always runs first; combines a static UMLS symptom floor (per ICD code) with cache-aside LLM-generated additions (skips the LLM on a fresh cache hit)
- **`02presentation/`** — two sub-phases:
  - `generation/` — generates a case outline, then an obviousness evaluate ⇄ regenerate `Command` loop (max 2 iterations); once accepted, fans out via `Send` to `patient_generate` / `chief_complaint_generate` / `anamnesis_generate` (gated per `generationFlags`), joining at `case_fan_in`
  - `inconsistency/` — evaluate ⇄ refine `Command` loop (default 2 iterations); excludes procedures
- **`03procedure/`** — only when the `procedures` flag is set. A **blinded solver** loop (max 6 iterations): `blinded_step` orders procedures without knowing the true diagnosis, `result_step` generates their results non-blinded; when the solver commits to a diagnosis, an LLM judge checks the match (loop continues with `ruledOutDiagnoses` on mismatch). On exhaustion, a `bridge` node generates confirmatory procedures for the true diagnosis.

**Tool pattern:** each subgraph directory has a `tools.ts` exporting `Tool<TInput, TOutput>` objects (`src/core/graph/utils/tool.ts`). Graph nodes are thin — prompt building, LLM calls, retries, and structured-output parsing live in the aigateway behind the tools. Nodes are wrapped with `traceNode()` (`utils/nodeWrapper.ts`) to emit "Node Started/Completed" bus events with translated labels.

**Generation flags** (`src/core/graph/models/GenerationFlags.ts`): `patient`, `chiefComplaint`, `anamnesis`, `procedures`. Requests also carry a **difficulty** (`models/Difficulty.ts`: `easy | medium | hard`, default `medium`).

### AI Gateway Layer

`src/core/graph/03aigateway/` contains one file per generated field (case, symptoms, patient, chiefComplaint, anamnesis, consistency, obviousness, procedures, diagnosis, labels, plus `translate.helper.ts`). Each gateway builds prompts, calls `getLLM()` / `getDeterministicLLM()` (temp 0.1) / `getCreativeLLM()` (temp 0.8) from `src/core/graph/utils/llm.ts`, and wraps calls with `retry()`.

`getLLM()` supports three providers: `ollama`, `google`, `openai` (the `openai` provider also serves OpenAI-compatible endpoints via `LLM_URL`). Provider/model come from env (`LLM_PROVIDER`, `LLM_MODEL`) or from per-request `llmConfig` passed via `RequestContext` (AsyncLocalStorage). The `ALLOW_LLMS` feature flag enables per-request LLM selection from an allowlist (`ALLOWED_LLMS=ollama:llama3.1,google:gemini-2.0-flash`); when set, no global LLM is configured and requests must supply `llmConfig` (exposed via `GET /api/allowedLlms`).

### Repo Layer (embedded SQLite via Drizzle)

`src/core/graph/03repo/` backs all lookups/caches with an embedded SQLite DB at `data/cache/aetiomed.db` (`node:sqlite`, WAL; Drizzle ORM, migrations in `drizzle/`, config in `drizzle.config.ts`):

- `db.ts` — opens the DB, runs migrations; `syncSource()` re-ingests a YAML file only when its sha256 changed (fingerprints in `_meta`)
- `schema.ts` — tables: `_meta`, `translation`, `diagnosis`, `predefined_item`, `symptom_cache`
- `translationStore.ts` — generic cache-aside translation store factory used by diagnosis, procedures, anamnesis categories, and trace labels; AI-generated translations persist in the DB (never written back to YAML)
- `diagnosis.repo.ts`, `procedures.repo.ts`, `anamnesis.repo.ts`, `labels.repo.ts` — sync their YAML sources and expose lookups / effective per-language lists
- `symptoms.repo.ts` — static UMLS floor from `data/diagnosis_symptoms.json` + LLM-symptom cache with TTL (`SYMPTOM_CACHE_TTL_DAYS`)

### Numbered Directory Convention

`src/core/graph/` uses numbered prefixes to indicate layer order:

- `02graphs/` — LangGraph graphs (subgraph directories are themselves numbered by phase)
- `03aigateway/` — LLM prompt/call functions
- `03repo/` — data access (YAML → SQLite sync, caches)

Plus unnumbered `models/` (Zod domain models), `utils/`, `errors/`, `config.ts`.

### REST Layer

`src/extensions/rest/` (requires the `REST` feature flag):

- `GET /api/health`, `GET /api/features`, `GET /api/allowedLlms`
- `routes/cases.router.ts` — `POST /api/cases` (runs `generateCase` inside `runWithContext`; aborts on client disconnect), `DELETE /api/cases/:jobId` (cancel)
- `routes/diagnosis.router.ts` — `GET /api/diagnosis`
- `routes/procedures.router.ts` — `GET /api/procedures`

### Data Files

`data/` contains files synced into the SQLite cache at startup (only re-parsed when changed):

- `procedures.yml` / `proceduresTranslations.yml` — predefined procedure names (when set, LLM must select from this list only)
- `diagnosis.yml` / `diagnosisTranslations.yml` — ICD-11 diagnosis lookup
- `anamnesisCategories.yml` / `anamnesisCategoriesTranslations.yml` — anamnesis section definitions (static config, no longer a request field)
- `labelTranslations.yml` — trace-node label translations
- `diagnosis_symptoms.json` — UMLS-derived symptom floor per ICD code (loaded directly, not via the DB sync)
- `cache/` — the embedded SQLite DB (generated)

The `procedures/` directory (root level) contains categorized procedure YAML source files and scripts to extract/compile them into `data/procedures.yml`. `scripts/extract-icd11*.ts` build the diagnosis YAML files from ICD-11 source data (run manually).

### Request Context

`runWithContext(fn, jobId?, llmConfig?)` in `src/core/graph/utils/context.ts` uses `AsyncLocalStorage` to propagate `jobId`, optional `llmConfig`, and an abort `signal` through the entire async call chain. It also sets up tracing and registers an `AbortController` with `cancelManager` (`utils/cancelManager.ts`) so generations can be cancelled by jobId. Graph nodes access it via `runtime?.context` (LangGraph passes `RequestContextSchema` as the runtime context schema) or `getRequestContext()`.

## Environment Variables

| Variable                      | Default                 | Notes                                                                                  |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `PORT`                        | `3030`                  | Server port                                                                            |
| `FEATURES`                    | `""`                    | Comma-separated flags: `REST`, `DEBUG`, `NATS`, `PERSISTENCY`, `TRACING`, `ALLOW_LLMS` |
| `LLM_PROVIDER`                | —                       | `ollama` \| `google` \| `openai` (required unless `ALLOW_LLMS`)                        |
| `LLM_MODEL`                   | —                       | Model name (required unless `ALLOW_LLMS`)                                              |
| `LLM_API_KEY`                 | —                       | API key for Google/OpenAI                                                              |
| `LLM_URL`                     | —                       | Override base URL (e.g. local Ollama or OpenAI-compatible endpoints)                   |
| `LLM_TEMPERATURE`             | `0.7`                   | 0–1                                                                                    |
| `ALLOWED_LLMS`                | —                       | Format: `ollama:model1,google:model2` (requires `ALLOW_LLMS` flag)                     |
| `NATS_URL`                    | `nats://localhost:4222` | `nats://nats:4222` in docker compose                                                   |
| `NATS_USER` / `NATS_PASSWORD` | `nats` / `nats`         |                                                                                        |
| `REDIS_URL`                   | —                       | Required for `PERSISTENCY` extension                                                   |
| `SYMPTOM_CACHE_TTL_DAYS`      | `30`                    | TTL for cached LLM-generated symptoms (see `03repo/symptoms.repo.ts`)                  |

Note: the `REST` flag is required for the HTTP API to load — include it in `FEATURES` when running the server.

## Path Aliases

`@/*` → `src/*` (configured in `tsconfig.json`; resolved at runtime by `tsx`, at build time by `tsc-alias`).
