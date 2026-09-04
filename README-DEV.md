# AetioMed - Developer Guide

This document provides technical details for setting up, running, and contributing to the AetioMed project.

This is a **backend-only** repository — no frontend lives here.

## Tech Stack

- **Runtime**: Node.js (>= 22.5, uses the built-in `node:sqlite`)
- **Language**: TypeScript (ESM, `@/*` → `src/*` path alias)
- **Framework**: Express 5
- **AI/LLM**: LangChain + LangGraph, with Ollama / Google / OpenAI-compatible providers
- **Database**: Embedded SQLite via Drizzle ORM (`data/cache/aetiomed.db`)
- **Message Broker**: NATS (JetStream) — optional
- **Cache/Store**: Redis — optional
- **Package Manager**: pnpm

## Prerequisites

- [Node.js](https://nodejs.org/) v22.5 or higher
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) & Docker Compose (only needed for NATS / Redis / local Ollama)

## Getting Started

### 1. Installation

```bash
git clone <repository-url>
cd AetioMed
pnpm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and adjust. The most important variable is `FEATURES` — it decides which extensions load at all.

> **Include `REST` in `FEATURES` if you want the HTTP API.** Without it the `rest` extension is skipped, and every extension depending on it (`swagger`, `persistency`, `tracingRest`, `tracingPersistency`) is cascade-skipped. The server starts and generates nothing, silently.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3030` | Server port |
| `FEATURES` | `""` | Comma-separated: `REST`, `DEBUG`, `NATS`, `PERSISTENCY`, `TRACING`, `ALLOW_LLMS` |
| `LLM_PROVIDER` | — | `ollama` \| `google` \| `openai` (required unless `ALLOW_LLMS`) |
| `LLM_MODEL` | — | Model name (required unless `ALLOW_LLMS`) |
| `LLM_API_KEY` | — | API key for Google / OpenAI |
| `LLM_URL` | — | Override base URL (local Ollama, or any OpenAI-compatible endpoint) |
| `LLM_GENERATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL` | — | Optional per-role override for the `generator` role; each field falls back individually to the general `LLM_*` value |
| `LLM_JUDGE_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL` | — | Optional per-role override for the `judge` role (same per-field fallback) |
| `LLM_TRANSLATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL` | — | Optional per-role override for the `translator` role (same per-field fallback) |
| `LLM_SMALL` | `false` | `true`/`1` enables small-model-friendly prompting (splits procedure picks into category-then-procedure) |
| `ALLOWED_LLMS` | — | `ollama:model1,google:model2` — requires the `ALLOW_LLMS` flag |
| `NATS_URL` | `nats://localhost:4222` | `nats://nats:4222` inside docker compose |
| `NATS_USER` / `NATS_PASSWORD` | `nats` / `nats` | |
| `REDIS_URL` | — | Required by the `PERSISTENCY` extension |
| `SYMPTOM_CACHE_TTL_DAYS` | `30` | TTL for cached LLM-generated symptoms |

**Per-request LLM selection.** With the `ALLOW_LLMS` flag set, no global LLM is configured; every request must supply its own `llmConfig`, validated against the `ALLOWED_LLMS` allowlist and discoverable via `GET /api/allowedLlms`. Without the flag, `LLM_PROVIDER`/`LLM_MODEL` are required and per-request `llmConfig` is rejected.

### 3. Running the Application

#### Option A: Infrastructure in Docker, server local (recommended for development)

```bash
docker compose --profile NATS --profile PERSISTENCY up -d
pnpm dev
```

`nats`/`nats-box` sit behind the `NATS` compose profile and `redis` behind `PERSISTENCY`, so omit whichever you don't need. `pnpm dev` regenerates the extension registry and runs `tsx watch` against `.env`, auto-restarting on file changes.

#### Option B: Full stack in Docker

```bash
docker compose up --build
```

Starts the server plus an Ollama instance that pulls `LLM_MODEL` on boot (the first pull can take a while for larger models). Note that the compose file's default `FEATURES` does not include `REST` — set it explicitly in your environment if you want the HTTP API from the container.

The server is available at `http://localhost:3030`.

## Commands

```bash
pnpm dev          # generate registry + run with tsx watch (loads .env)
pnpm build        # generate registry + tsc + tsc-alias
pnpm start        # run compiled dist/index.js
pnpm lint         # eslint
pnpm lint:fix     # eslint --fix
pnpm format       # prettier --write
pnpm generate     # regenerate src/extensions/_registry.ts (automatic in dev/build)
pnpm db:generate  # drizzle-kit generate — regenerate SQL migrations into drizzle/
pnpm swagger      # regenerate swagger-output.json
pnpm graph:export # export the LangGraph diagrams as SVGs into docs/
```

`pnpm graph:export` renders via Mermaid and needs a Chrome binary bound to Puppeteer first:

```bash
pnpm exec puppeteer browsers install chrome
```

## Architecture

### Layout

```
src/
├── index.ts                  entry point
├── core/
│   ├── app.ts                creates the EventBus, inits the graph, loads extensions
│   ├── event-bus.ts          typed pub/sub; extensions augment EventMap
│   ├── extension.ts          defineExtension() + types
│   ├── loader.ts             topo-sort, flag gating, cascade-skip, env parsing
│   └── graph/                the case-generation pipeline (NOT an extension)
│       ├── 02graphs/         LangGraph graphs, numbered by phase
│       ├── 03aigateway/      prompt building, LLM calls, retries, output parsing
│       ├── 03repo/           data access: YAML → SQLite sync, caches
│       ├── models/           Zod domain models
│       ├── utils/            llm, context, retry, prompt, tracing wrapper
│       └── errors/
└── extensions/               auto-discovered plugins
```

The numbered prefixes under `core/graph/` encode layer order: graphs call tools, tools call the aigateway, the aigateway calls the repo.

### Extension System

Extensions are auto-discovered by `scripts/generate-registry.ts`, which writes `src/extensions/_registry.ts`. **Never edit that file manually** — it regenerates on every `pnpm dev` / `pnpm build`.

| Extension | Required Flags | Depends On | Purpose |
| --- | --- | --- | --- |
| `api` | — | — | Shared request/response Zod schemas; no runtime behavior |
| `debugLogger` | `DEBUG` | — | Logs every bus event to the console |
| `nats` | `NATS` | `api` | Async case generation over JetStream (`cases.generate`, cancel via `cases.cancel.>`) |
| `persistency` | `PERSISTENCY` | `rest` | Saves completed cases to Redis; mounts its router |
| `rest` | `REST` | `api` | Express server; exports the shared `apiRouter` mounted at `/api` |
| `swagger` | — | `rest` | Serves Swagger UI |
| `tracing` | `TRACING` | — | Bridges bus lifecycle events onto per-job trace buses |
| `tracingNats` | — | `tracing`, `nats` | Republishes trace events to `cases.traces.${jobId}` |
| `tracingPersistency` | — | `rest`, `persistency`, `tracing` | Persists trace logs to Redis (`traces:${jobId}`, 24h TTL) |
| `tracingRest` | — | `tracing`, `rest` | SSE live trace streaming |

To add one, create `src/extensions/<name>/index.ts` exporting `extension`:

```ts
export const extension = defineExtension({
  name: "myExtension",
  requiredFlags: ["MY_FLAG"],
  dependsOn: [restExtension] as const,
  envSchema: z.object({ MY_VAR: z.string() }),
  async setup({ config, bus, dep }) {
    bus.on("Generation Completed", ({ case: c, jobId }) => { /* … */ });
  },
});
```

To publish new events, augment `EventMap` via module augmentation on `core/event-bus.js` — that keeps `emit`/`on` type-checked without either side importing the other.

### Graph ↔ Extension Boundary

The graph is core, not a plugin, and is initialized directly by `createApp()`. Extensions interact with it in exactly two ways:

**Invoking it** — transports (`rest`, `nats`) call:

```ts
runWithContext(
  () => generateCase(diagnosis, generationFlags, userInstructions, language, difficulty),
  jobId,
  llmConfig
);
```

`runWithContext` uses `AsyncLocalStorage` to thread `jobId`, `llmConfig`, and an `AbortSignal` through the entire async call chain, sets up tracing, and registers an `AbortController` with `cancelManager` so the job can be cancelled by id. Graph nodes read it from LangGraph's runtime context or via `getRequestContext()`.

**Observing it** — the graph emits onto the bus and never awaits the result:

| Event | Emitted by |
| --- | --- |
| `Node Started` / `Node Completed` | the `traceNode()` wrapper around every graph node |
| `Generation Log` | graph nodes and AI gateways |
| `Generation Completed` / `Generation Failure` / `Generation Cancelled` | the **transports**, not the graph itself |

Note the last row: the graph returns a case or throws; it's `cases.router.ts` / `cases.handler.ts` that translate that into a terminal bus event. Extensions relying on completion events therefore only see jobs that went through a transport.

### Tool Pattern

Each subgraph directory has a `tools.ts` exporting `Tool<TInput, TOutput>` objects. Graph nodes stay thin — they assemble inputs, `invoke` a tool, log, and return a `Command`. All prompt construction, LLM invocation, retry, and structured-output parsing lives in the aigateway behind the tool.

When adding an LLM call, put it in `03aigateway/`, expose it as a `Tool`, and call the tool from the node. Don't call an LLM from a node directly.

### AI Gateway Conventions

One file per generated field. Each builds prompts with `buildPrompt`/`section`, picks a temperature-appropriate model, and wraps the call in `retry()`:

- `getDeterministicLLM()` (0.1) — judges, evaluations, translations, factual enumeration
- `getBalancedLLM()` (0.4) — clinical decision-making, output already pinned down by the outline
- `getCreativeLLM()` (0.7) — open-ended narrative: outlines, patient voice, demographics

For structured output, keep the **grammar/prompt split**: pass the fully constrained schema (including large literal unions of approved names) to `withStructuredOutput`, but render a name-agnostic version into the prompt. `renderSchemaForPrompt` enforces this by collapsing literal unions longer than 8 members to `string`. This keeps prompts short and stable while the constraint stays exact.

Retry prompts get `summarizeValidationError()` output — a few short actionable lines — rather than a raw Zod issue dump.

### Repo Layer

All lookups and caches are backed by an embedded SQLite database at `data/cache/aetiomed.db` (`node:sqlite`, WAL mode; Drizzle ORM, migrations in `drizzle/`).

`syncSource()` re-ingests a YAML file **only when its sha256 changed** since the last sync, with fingerprints kept in `_meta`. This matters: the largest source is a ~37k-entry translation file, and re-parsing it on every boot cost seconds. On an unchanged file, startup skips parsing entirely.

Tables: `_meta`, `translation`, `diagnosis`, `predefined_item`, `symptom_cache`.

`translationStore.ts` is a generic cache-aside translation store factory shared by diagnoses, procedures, anamnesis categories, and trace labels. AI-generated translations are upserted into the DB and survive restarts, but are **never written back to the YAML sources** — a YAML edit overwrites only the keys the YAML declares.

### Data Files

`data/` holds the sources synced into SQLite at startup:

- `procedures.yml` / `proceduresTranslations.yml` — approved procedure names. Names may be prefixed `"Category: Name"`; uncategorized entries fall into a synthetic `"General"` bucket.
- `diagnosis.yml` / `diagnosisTranslations.yml` — ICD-11 diagnosis lookup
- `anamnesisCategories.yml` / `anamnesisCategoriesTranslations.yml` — anamnesis section definitions
- `labelTranslations.yml` — trace step label translations
- `diagnosis_symptoms.json` — UMLS symptom floor per ICD code (loaded directly, not via the DB sync)
- `cache/` — the generated SQLite database

The root-level `procedures/` directory holds the categorized source YAML and the scripts that compile them into `data/procedures.yml`. `scripts/extract-icd11*.ts` build the diagnosis YAML from ICD-11 source data; both are run manually.

## REST API

Requires the `REST` feature flag.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/features` | Active feature flags |
| `GET` | `/api/allowedLlms` | Allowlisted LLMs (when `ALLOW_LLMS` is set) |
| `POST` | `/api/cases` | Generate a case (accepts `?jobId=`; aborts on client disconnect) |
| `DELETE` | `/api/cases/:jobId` | Cancel an in-flight generation |
| `GET` | `/api/diagnosis` | List predefined diagnoses |
| `GET` | `/api/procedures` | List predefined procedures |
| `GET` | `/api/cases` | List persisted cases (`persistency`) |
| `GET` | `/api/traces` | List persisted trace job ids (`tracingPersistency`) |
| `GET` | `/api/traces/:jobId` | Fetch a persisted trace log (`tracingPersistency`) |
| `GET` | `/api/traces/:jobId/stream` | Live SSE trace stream (`tracingRest`) |

A request body needs either `icd` or `diagnosis`; `generationFlags` defaults to all four fields and `difficulty` to `medium`.

Swagger UI is served at the API root once the `swagger` extension loads:

```
http://localhost:3030/api
```

## NATS API

Requires the `NATS` feature flag. The JetStream stream `cases` is created on startup with a workqueue retention policy.

| Subject | Direction | Purpose |
| --- | --- | --- |
| `cases.generate` | in | Case generation request (same body as `POST /api/cases`, plus an optional `jobId`) |
| `cases.generated` | out | Completed case or error payload, keyed by `jobId` |
| `cases.cancel.>` | in | Cancel a job (id from the body or the last subject token) |
| `cases.traces.${jobId}` | out | Live trace events (`tracingNats`) |

The consumer acks on success *and* on handled errors (it publishes an error payload instead), naking only when publishing itself fails.

## Testing & Verification

```bash
pnpm lint
pnpm format:check
```

There is no automated test suite yet. Pipeline changes are verified by running a generation and inspecting the trace — either via the SSE stream or with `DEBUG` in `FEATURES`, which logs every bus event including full prompts and raw LLM responses.

## Additional Tools

- **Bruno**: ready-made API requests in `docs/bruno/` for exercising the endpoints.
- **Graph diagrams**: `docs/case-graph.svg` (full) and `docs/case-graph-overview.svg` (translation phases collapsed), regenerated by `pnpm graph:export`.
