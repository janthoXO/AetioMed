# AetioMed - Developer Guide

This document provides technical details for setting up, running, and contributing to the AetioMed project.

This is a **backend-only** repository — no frontend lives here.

## Tech Stack

- **Runtime**: Node.js (>= 22.5, uses the built-in `node:sqlite`)
- **Language**: TypeScript (ESM, `@/*` → `src/*` path alias)
- **Framework**: Express 5
- **AI/LLM**: LangChain + LangGraph, with Ollama / Google / OpenAI-compatible providers
- **Database**: Embedded SQLite via Drizzle ORM (default `data/cache/aetiomed.db`, see `CACHE_DIR`)
- **Message Broker**: NATS (JetStream) — optional
- **Observability**: OpenTelemetry (OTLP span export) — optional
- **Language detection**: `tinyld` (offline n-gram)
- **Testing**: Vitest
- **Package Manager**: pnpm

## Prerequisites

- [Node.js](https://nodejs.org/) v22.5 or higher
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) & Docker Compose (only needed for NATS or a local Ollama)

## Getting Started

### 1. Installation

```bash
git clone <repository-url>
cd AetioMed
pnpm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and adjust. The most important variable is `FEATURES` — it decides which transports start.

> **Include `REST` in `FEATURES` if you want the HTTP API.** Without it `startRestServer` is simply never called, and with it the SSE trace stream and `GET /api/graph` (both mounted onto the REST app) are unreachable too. The server starts and generates nothing, silently.

| Variable                                                   | Default                 | Notes                                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                     | `3030`                  | Server port                                                                                                                                                                 |
| `FEATURES`                                                 | `""`                    | Comma-separated: `REST`, `NATS`, `TRACING`, `DEBUG`, `ALLOW_LLMS`                                                                                                           |
| `LLM_PROVIDER`                                             | —                       | `ollama` \| `google` \| `openai` (required unless `ALLOW_LLMS`)                                                                                                             |
| `LLM_MODEL`                                                | —                       | Model name (required unless `ALLOW_LLMS`)                                                                                                                                   |
| `LLM_API_KEY`                                              | —                       | API key for Google / OpenAI                                                                                                                                                 |
| `LLM_URL`                                                  | —                       | Override base URL (local Ollama, or any OpenAI-compatible endpoint)                                                                                                         |
| `LLM_GENERATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`  | —                       | Optional per-role override for the `generator` role; each field falls back individually to the general `LLM_*` value. Setting `_PROVIDER` without `_MODEL` fails at startup |
| `LLM_JUDGE_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`      | —                       | Same, for the `judge` role                                                                                                                                                  |
| `LLM_TRANSLATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL` | —                       | Same, for the `translator` role                                                                                                                                             |
| `ALLOWED_LLMS`                                             | —                       | `ollama:model1,google:model2` — requires the `ALLOW_LLMS` flag                                                                                                              |
| `TRANSLATION_SANDWICH`                                     | `true`                  | `false`/`0` compiles the translation phases out of the graph entirely                                                                                                       |
| `PROCEDURE_PRESELECTION`                                   | `false`                 | `true`/`1` selects the category-scoped procedure strategy                                                                                                                   |
| `LANGUAGES`                                                | `English,German`        | Comma-separated deployment language set; must include `English`. A request's `language` is validated against it (400 if outside)                                            |
| `LANGUAGE_AUTO_DETECT`                                     | `false`                 | `true`/`1` enables offline n-gram detection for a request that omits `language`; not a graph flag                                                                           |
| `LANGUAGE_DETECT_LLM_FALLBACK`                             | `false`                 | `true`/`1` additionally allows one LLM call when the detector is below threshold; requires `LANGUAGE_AUTO_DETECT`                                                           |
| `CATALOG_DIR`                                              | `data`                  | Deployer-owned, read-only catalogue inputs; resolved against `process.cwd()` when relative                                                                                  |
| `CACHE_DIR`                                                | `data/cache`            | Generated, writable output — the SQLite database lives here                                                                                                                 |
| `SYMPTOM_CACHE_TTL_DAYS`                                   | `30`                    | TTL for cached LLM-generated symptoms                                                                                                                                       |
| `MAX_CONTENT_PART_BYTES`                                   | `5000000`               | Ceiling on one content part's decoded size; encoding a larger part fails loudly                                                                                             |
| `NATS_URL`                                                 | `nats://localhost:4222` | `nats://nats:4222` inside docker compose                                                                                                                                    |
| `NATS_USER` / `NATS_PASSWORD`                              | `nats` / `nats`         |                                                                                                                                                                             |
| `OTEL_SDK_DISABLED`                                        | unset (enabled)         | Standard OTel var; `"true"` skips constructing the OTel SDK entirely — independent of `FEATURES=TRACING`                                                                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                              | —                       | Standard OTel var, read by the OTLP exporter itself                                                                                                                         |
| `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`           | —                       | Standard OTel vars, read via `envDetector`                                                                                                                                  |

**Per-request LLM selection.** With the `ALLOW_LLMS` flag set, no global LLM is configured; every request must supply its own `llmConfig`, validated against the `ALLOWED_LLMS` allowlist and discoverable via `GET /api/allowedLlms`. Without the flag, `LLM_PROVIDER`/`LLM_MODEL` are required and per-request `llmConfig` is rejected.

### 3. Running the Application

#### Option A: Infrastructure in Docker, server local (recommended for development)

```bash
docker compose --profile NATS up -d
pnpm dev
```

`nats`/`nats-box` sit behind the `NATS` compose profile, so omit it if you don't need them. `pnpm dev` runs `tsx watch` against `.env`, auto-restarting on file changes.

#### Option B: Full stack in Docker

```bash
docker compose up --build
```

Starts the server plus an Ollama instance that pulls `LLM_MODEL` on boot (the first pull can take a while for larger models).

The server is available at `http://localhost:3030`.

## Commands

```bash
pnpm dev          # run with tsx watch (loads .env)
pnpm build        # tsc + tsc-alias
pnpm start        # run compiled dist/index.js
pnpm test         # vitest run
pnpm test:watch   # vitest
pnpm lint         # eslint
pnpm lint:fix     # eslint --fix
pnpm format       # prettier --write src
pnpm format:check # prettier --check src
pnpm db:generate  # drizzle-kit generate — regenerate SQL migrations into drizzle/
pnpm graph:export # export the LangGraph diagrams into docs/graphs/
```

`pnpm format`/`format:check` cover `src` only. Format markdown, `package.json`, the workflows and `scripts/` by hand with `npx prettier --write <path>`.

`pnpm graph:export` renders via Mermaid and needs a Chrome binary bound to Puppeteer first:

```bash
pnpm exec puppeteer browsers install chrome
```

## Architecture

### Layout

```
src/
├── index.ts                  entry point
├── api/                      shared request/response Zod schemas + wire codec
├── core/
│   ├── app.ts                the composition root — builds and starts everything
│   ├── event-bus.ts          typed pub/sub; modules augment EventMap
│   ├── caseGenerationService.ts  the seam both transports call
│   ├── languageDetection/    the request-language resolution ladder
│   └── graph/                the case-generation pipeline
│       ├── runtime.ts        GraphRuntime — the port bundle (llm, catalogs, log, clock)
│       ├── repos.ts          composes every repo into one bundle
│       ├── config.ts         graph env schema
│       ├── 02graphs/         LangGraph graphs, numbered by pipeline phase
│       ├── 03aigateway/      prompt building, LLM calls, retries, output parsing
│       ├── catalog/          one vertical slice per catalogue domain (repo + port adapters)
│       ├── persistence/      shared SQLite infrastructure
│       ├── symptoms/         the symptom cache slice
│       ├── medicalBasis/     plan-input provider registry
│       ├── modality/         content-rendering provider registry
│       ├── models/           Zod domain models
│       ├── utils/            llm, context, retry, prompt, node wrapper
│       └── errors/
├── transports/
│   ├── rest/                 Express server and routers
│   └── nats/                 JetStream consumer and publisher
└── tracing/
    ├── sse/                  live label + trace streaming
    ├── structure/            GET /api/graph
    └── otel.ts               the OTel span channel
```

The numbered prefixes under `core/graph/` encode pipeline order: graphs call tools, tools call the aigateway. `persistence/`, `catalog/`, `symptoms/`, `medicalBasis/` and `modality/` are deliberately unnumbered — they are not pipeline steps.

### Composition Root

`createApp()` (`src/core/app.ts`) constructs everything explicitly, in order: parse `FEATURES`, resolve `CATALOG_DIR`/`CACHE_DIR`, build the OTel tracer, `initGraph()` (repos → `GraphRuntime` → compiled graph → catalogue validation), then `createCaseGenerationService()`, then start each transport whose flag is set.

**`GraphRuntime`** is the single seam graph construction goes through. It is captured **by closure at graph-assembly time** — not threaded through node signatures, and not carried on LangGraph's per-invocation runtime context. Nothing under `src/core/graph/` imports a mutable module singleton or reads `process.env`.

**`CaseGenerationService`** is what both transports call. It owns ICD→name resolution, language resolution, job ids, `runWithContext`, generation-flag normalisation, terminal event emission and error→status mapping, and returns a job shape (`{ jobId, status, case?, error?, language }`) rather than a bare `Case`. Routers are protocol translation only.

To publish new events, augment `EventMap` via module augmentation on `core/event-bus.js` — that keeps `emit`/`on` type-checked without either side importing the other.

### Graph Assembly

`assembleCaseGraph(deps, flags)` is pure wiring, and follows one rule:

> **Compile on what the deployer chose; branch on what the caller asked for.**

`TRANSLATION_SANDWICH` and `PROCEDURE_PRESELECTION` are deployment config and are compiled away — an absent flag means an **absent node**, not a skipped one. `generationFlags`, `difficulty` and `language` are per-request and stay runtime branches. All four flag combinations are compiled eagerly at boot; `generateCase` is bound to the one the config selects.

### Tool Pattern

Each subgraph directory has a `tools.ts` exporting `Tool<TInput, TOutput>` objects. Graph nodes stay thin — they assemble inputs, `invoke` a tool, log, and return a `Command`. All prompt construction, LLM invocation, retry, and structured-output parsing lives in the aigateway behind the tool.

When adding an LLM call, put it in `03aigateway/`, expose it as a `Tool`, and call the tool from the node. Don't call an LLM from a node directly.

### AI Gateway Conventions

One file per generated field. Each builds prompts with `buildSystemPrompt`/`section` and wraps the call in `retry()`.

Model selection goes through one method on the port, carrying two independent dimensions:

```ts
runtime.llm.for({ role, temperature }, context?.llmConfig);
```

- **role** — `generator` | `judge` | `translator`, each independently configurable per env, so a deployer can run a small local generator against a stronger judge. Generators and judges being the same model is the pipeline's structural blind spot; this is the seam that fixes it.
- **temperature** — a fixed policy class, not configuration: `deterministic` (0.1) for judges and translations, `balanced` (0.4) for clinical decisions already pinned down by the outline, `creative` (0.7) for open-ended narrative.

System prompts go through `buildSystemPrompt(runtime, audience, ...sections)`, where `audience` is `internal` or `user-facing`. Internal artifacts (the plan, the plan judge, the blinded solver, `matchDiagnosis`) are always English; only user-facing generators receive the target-language directive, and only when the translation sandwich is off.

For structured output, keep the **grammar/prompt split**: pass the fully constrained schema (including large literal unions of approved names) to `withStructuredOutput`, but render a name-agnostic version into the prompt. `renderSchemaForPrompt` enforces this by collapsing literal unions longer than 8 members to `string`. This keeps prompts short and stable while the constraint stays exact.

Retry prompts get `summarizeValidationError()` output — a few short actionable lines — rather than a raw Zod issue dump.

### Content Parts

`chiefComplaint`, each `anamnesis[].answer` and each `procedures[].result` are ordered, non-empty arrays of `ContentPart` (`{ type, value: Uint8Array, alt }`). The array **composes** one field value; it is not a list of alternative renditions.

For a text part `value` is derived from `alt` through the single `textPart()` constructor, so translation touches `alt` and re-derives `value` and the two cannot drift. `textOf(parts)` is the only path from content to a prompt — **bytes never reach a prompt or an LLM output schema**. Wire encoding (UTF-8 for `text/*`, base64 otherwise) lives in one place, `src/api/contentWire.ts`.

### Data Layer

All lookups and caches are backed by an embedded SQLite database under `CACHE_DIR` (`node:sqlite`, WAL mode; Drizzle ORM, migrations in `drizzle/`).

The code is organised as vertical slices rather than one repo directory: shared infrastructure in `core/graph/persistence/`, each catalogue domain's repo beside its port adapters in `core/graph/catalog/<domain>/`, the symptom cache in `core/graph/symptoms/`, all composed by `core/graph/repos.ts`. **Every repo module exports a `createXxx(...)` factory and performs no I/O on import** — `repos.test.ts` enforces that.

`syncSource()` re-ingests a YAML file **only when its sha256 changed** since the last sync, with fingerprints kept in `_meta`. This matters: the largest source is a ~37k-entry translation file, and re-parsing it on every boot cost seconds.

Tables: `_meta`, `translation`, `diagnosis`, `predefined_item`, `symptom_cache`.

`translationStore.ts` is a cache-aside translation store shared by diagnoses, procedures, anamnesis categories and trace labels. In-flight work is deduped **per key**, and AI-generated translations are persisted with `source: "generated"` but **never written back to the YAML sources**.

### Data Files

`CATALOG_DIR` (default `data/`) holds the sources synced into SQLite at startup:

- `procedures.yml` / `proceduresTranslations.yml` — approved procedure names. Names may be prefixed `"Category: Name"`; uncategorized entries fall into a synthetic `"General"` bucket.
- `diagnosis.yml` / `diagnosisTranslations.yml` — ICD-11 diagnosis lookup
- `anamnesisCategories.yml` / `anamnesisCategoriesTranslations.yml` — anamnesis section definitions
- `labelTranslations.yml` — trace step label translations
- `diagnosis_symptoms.json` — UMLS symptom floor per ICD code (loaded directly, not via the DB sync)

The generated database lives under `CACHE_DIR` (default `data/cache/`), deliberately a separate directory so a deployer can mount their own catalogues without clobbering it. `scripts/extract-icd11*.ts` build the diagnosis YAML from ICD-11 source data and are run manually.

## REST API

Requires the `REST` feature flag.

| Method   | Path                        | Purpose                                                                                              |
| -------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`               | Health check                                                                                         |
| `GET`    | `/api/features`             | Active feature flags                                                                                 |
| `GET`    | `/api/allowedLlms`          | Allowlisted LLMs (when `ALLOW_LLMS` is set)                                                          |
| `POST`   | `/api/cases`                | Generate a case (accepts `?jobId=`; aborts on client disconnect)                                     |
| `DELETE` | `/api/cases/:jobId`         | Cancel an in-flight generation                                                                       |
| `GET`    | `/api/diagnosis`            | List predefined diagnoses                                                                            |
| `GET`    | `/api/procedures`           | List predefined procedures                                                                           |
| `GET`    | `/api/traces/:jobId/stream` | Live SSE stream: `event: label` (localized) and `event: trace` (English, node-bound) (`TRACING`)     |
| `GET`    | `/api/graph`                | Compiled graph topology (nodes + edges + English label keys) for this deployment's flags (`TRACING`) |

A request body needs either `icd` or `diagnosis`; `generationFlags` defaults to all four fields and must name at least one; `difficulty` defaults to `medium`. The response echoes the resolved `language`, and content-bearing fields are wire-encoded (see Content Parts).

## NATS API

Requires the `NATS` feature flag. The JetStream stream `cases` is created on startup with a workqueue retention policy.

| Subject           | Direction | Purpose                                                                            |
| ----------------- | --------- | ---------------------------------------------------------------------------------- |
| `cases.generate`  | in        | Case generation request (same body as `POST /api/cases`, plus an optional `jobId`) |
| `cases.generated` | out       | Completed case or error payload, keyed by `jobId`                                  |
| `cases.cancel.>`  | in        | Cancel a job (id from the body or the last subject token)                          |

The consumer acks on success _and_ on handled errors (it publishes an error payload instead), naking only when publishing itself fails.

## Testing & Verification

```bash
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

There is a Vitest suite of ~40 files co-located next to their sources, covering graph assembly, config parsing, catalogues and startup validation, the content-part wire codec, the translation store and split, tracing and OTel, language detection, the medical-basis and modality registries, and the no-I/O-on-import invariant.

**`tsconfig.json` excludes `**/_.test.ts`and includes only`src/\*\*/_`**, so `tsc`does not typecheck test files or`scripts/`. A type error in a test surfaces only if an assertion happens to catch it — verify tests by running them, not by trusting the build.

For pipeline changes, run a generation and inspect the trace via the SSE stream. `DEBUG` in `FEATURES` adds `cors` and request logging to the REST app.

## Additional Tools

- **Bruno**: ready-made API requests in `docs/bruno/` for exercising the endpoints.
- **Graph diagrams**: `docs/graphs/case-graph.<topology>.svg` (full) and `docs/graphs/case-graph-overview.<topology>.svg` (translation phases collapsed), regenerated by `pnpm graph:export`. `<topology>` is `none` or `translation-sandwich` — `PROCEDURE_PRESELECTION` swaps a strategy adapter without changing the graph's shape, so it does not get its own diagram.
