# AetioMed Developer Guide — Setup, Configuration, REST and NATS API

This guide covers how to install, configure, run, test and extend AetioMed, the LLM-based synthetic medical case generator. For what AetioMed does and why, see the [README](README.md).

This is a **backend-only** repository — no frontend lives here.

## Tech Stack

- **Runtime**: Node.js (>= 24.21, uses the built-in `node:sqlite`; the shipped images run Node 26)
- **Language**: TypeScript (ESM, `@/*` → `src/*` path alias)
- **Framework**: Express 5
- **AI/LLM**: LangChain + LangGraph, with Ollama / Google / OpenAI-compatible providers
- **Database**: Embedded SQLite via Drizzle ORM (default `data/cache/aetiomed.db`, see `CACHE_DIR`)
- **Message Broker**: NATS — JetStream for requests and results, core NATS for progress, `@nats-io/services` for reads — optional
- **Observability**: OpenTelemetry — spans plus correlated log records, over OTLP or to the console — optional
- **Language detection**: `tinyld` (offline n-gram)
- **Testing**: Vitest
- **Package Manager**: pnpm

## Prerequisites

- [Node.js](https://nodejs.org/) v24.21 or higher
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) & Docker Compose (only needed for NATS or a local Ollama)

## How to Install and Run

### 1. Installation

```bash
git clone https://github.com/janthoXO/AetioMed.git
cd AetioMed
pnpm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and adjust. The most important variable is `FEATURES` — it decides which transports start.

> **Include `REST` and/or `NATS` in `FEATURES`.** Each transport starts only when its flag is set. With neither, the server boots, builds the graph, and serves nothing — silently.

| Variable                                                              | Default                 | Notes                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                                | `3030`                  | Server port                                                                                                                                                                 |
| `FEATURES`                                                            | `""`                    | Comma-separated: `REST`, `NATS`, `DEBUG`, `ALLOW_LLMS`                                                                                                                      |
| `LLM_PROVIDER`                                                        | —                       | `ollama` \| `google` \| `openai` (required unless `ALLOW_LLMS`)                                                                                                             |
| `LLM_MODEL`                                                           | —                       | Model name (required unless `ALLOW_LLMS`)                                                                                                                                   |
| `LLM_API_KEY`                                                         | —                       | API key for Google / OpenAI                                                                                                                                                 |
| `LLM_URL`                                                             | —                       | Override base URL (local Ollama, or any OpenAI-compatible endpoint)                                                                                                         |
| `LLM_GENERATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`             | —                       | Optional per-role override for the `generator` role; each field falls back individually to the general `LLM_*` value. Setting `_PROVIDER` without `_MODEL` fails at startup |
| `LLM_JUDGE_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`                 | —                       | Same, for the `judge` role                                                                                                                                                  |
| `LLM_TRANSLATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`            | —                       | Same, for the `translator` role                                                                                                                                             |
| `ALLOWED_LLMS`                                                        | —                       | `ollama:model1,google:model2` — requires the `ALLOW_LLMS` flag                                                                                                              |
| `TRANSLATION_SANDWICH`                                                | `true`                  | `false`/`0` compiles the translation phases out of the graph entirely                                                                                                       |
| `PROCEDURE_PRESELECTION`                                              | `false`                 | `true`/`1` selects the category-scoped procedure strategy                                                                                                                   |
| `LANGUAGES`                                                           | `English,German`        | Comma-separated deployment language set; must include `English`. A request's `language` is validated against it (400 if outside)                                            |
| `LANGUAGE_AUTO_DETECT`                                                | `false`                 | `true`/`1` enables offline n-gram detection for a request that omits `language`; not a graph flag                                                                           |
| `LANGUAGE_DETECT_LLM_FALLBACK`                                        | `false`                 | `true`/`1` additionally allows one LLM call when the detector is below threshold; requires `LANGUAGE_AUTO_DETECT`                                                           |
| `CATALOG_DIR`                                                         | `data`                  | Deployer-owned, read-only catalogue inputs; resolved against `process.cwd()` when relative                                                                                  |
| `CACHE_DIR`                                                           | `data/cache`            | Generated, writable output — the SQLite database lives here                                                                                                                 |
| `SYMPTOM_CACHE_TTL_DAYS`                                              | `30`                    | TTL for cached LLM-generated symptoms                                                                                                                                       |
| `MAX_CONTENT_PART_BYTES`                                              | `5000000`               | Ceiling on one content part's decoded size; encoding a larger part fails loudly                                                                                             |
| `NATS_URL`                                                            | `nats://localhost:4222` | `nats://nats:4222` inside docker compose                                                                                                                                    |
| `NATS_USER` / `NATS_PASSWORD`                                         | `nats` / `nats`         |                                                                                                                                                                             |
| `MAX_CONCURRENT_GENERATIONS`                                          | `4`                     | Bounds in-flight generations identically over REST and NATS; excess requests queue, and a queued one is still cancellable                                                   |
| `OTEL_SDK_DISABLED`                                                   | unset (enabled)         | Standard OTel var; `"true"` (that literal only) skips constructing the OTel SDK entirely — its own axis, independent of `FEATURES`                                          |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `_TRACES_ENDPOINT` / `_LOGS_ENDPOINT` | —                       | Standard OTel vars, read by the OTLP exporters themselves; any one set selects the `otlp` exporter mode (batch spans + batch logs)                                          |
| `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`                      | —                       | Standard OTel vars, read via `envDetector`                                                                                                                                  |

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
├── index.ts                  entry point — installs signal handlers, calls createApp()
├── api/                      shared request/response Zod schemas, JobId rule, wire codec
├── core/
│   ├── app.ts                the composition root — builds and starts everything
│   ├── caseGenerationService.ts  the seam both transports call
│   ├── concurrency.ts        the FIFO limiter behind MAX_CONCURRENT_GENERATIONS
│   ├── jobEvents/            the per-job event channel, progress labels, the JobDirectory port
│   ├── readModel.ts          catalogue/meta/graph reads, served identically by both transports
│   ├── event-bus.ts          typed pub/sub between the graph and its observers
│   ├── languageDetection/    the request-language resolution ladder
│   └── graph/                the case-generation pipeline
│       ├── runtime.ts        GraphRuntime — the port bundle (llm, catalogs, log, clock)
│       ├── repos.ts          composes every repo into one bundle
│       ├── config.ts         graph env schema
│       ├── structure.ts      the actually-compiled topology behind GET /api/graph
│       ├── 02graphs/         LangGraph graphs, numbered by pipeline phase
│       ├── 03aigateway/      prompt building, LLM calls, retries, output parsing
│       ├── catalog/          one vertical slice per catalogue domain (repo + port adapters)
│       ├── persistence/      shared SQLite infrastructure
│       ├── symptoms/         the symptom cache slice
│       ├── medicalBasis/     plan-input provider registry
│       ├── modality/         per-field planner grammar + rendering pipeline
│       ├── models/           Zod domain models
│       ├── utils/            llm, context, retry, prompt, node wrapper
│       └── errors/
├── transports/
│   ├── rest/                 Express app (createRestApp), SSE framing, routers
│   └── nats/                 streams + worker, per-job responders, progress publisher,
│                             meta service, and the NATS JobDirectory adapter
└── observability/
    ├── otel.ts               the OTel adapter — exporter selection, spans, log records
    └── tracePayload.ts       the size cap on a node's output in a log record
```

The numbered prefixes under `core/graph/` encode pipeline order: graphs call tools, tools call the aigateway. `persistence/`, `catalog/`, `symptoms/`, `medicalBasis/` and `modality/` are deliberately unnumbered — they are not pipeline steps.

**Dependency direction** is enforced by `src/core/graph/importBoundary.test.ts`: nothing under `core/graph/` imports a transport or `observability/`, nothing under `core/` imports `@opentelemetry/*`, and nothing under `transports/nats/` imports `transports/rest/`.

### Composition Root

`createApp()` (`src/core/app.ts`) constructs everything explicitly, in order: parse `FEATURES`, resolve `CATALOG_DIR`/`CACHE_DIR`, build the OTel tracer, `initGraph()` (repos → `GraphRuntime` → compiled graph → catalogue validation), the per-job event channel and its label producer, `createCaseGenerationService()` and the `ReadModel`, then the transports — NATS before REST, because REST may use NATS to find jobs. Shutdown runs the other way: REST, NATS, the OTel flush, then the database, each bounded by one deadline. There is no plugin loader and no module registers its own signal handler.

**`GraphRuntime`** is the single seam graph construction goes through. It is captured **by closure at graph-assembly time** — not threaded through node signatures, and not carried on LangGraph's per-invocation runtime context. Nothing under `src/core/graph/` imports a mutable module singleton or reads `process.env`.

**`CaseGenerationService`** is what both transports call. It owns ICD→name resolution, language resolution, job ids, `runWithContext`, generation-flag normalisation, terminal event emission and error→status mapping, and returns a job shape (`{ jobId, status, case?, error?, language }`) rather than a bare `Case`. Routers are protocol translation only. It also owns the job lifecycle and the concurrency limit — see Jobs and Transports.

To publish new events, augment `EventMap` via module augmentation on `core/event-bus.js` — that keeps `emit`/`on` type-checked without either side importing the other.

### Jobs and Transports

REST and NATS are peers: every product feature is reachable from both, and a client speaking only one of them loses nothing. They differ only in delivery guarantees — REST is **connection-scoped** (a job lives as long as its HTTP request), NATS is **durable** (JetStream persists requests and results). Neither transport holds job state of its own; it all lives in core.

**The per-job event channel** (`core/jobEvents/channel.ts`) is created once in `app.ts`. `CaseGenerationService` opens a job's channel and closes it with the job's outcome; transports only subscribe. A job's events are `accepted` → `label`… → `complete`, and those names are the wire names on both transports — the SSE `event:` name on REST, the last subject token on NATS — so no adapter keeps a mapping table. `complete` carries the outcome (`done` / `failed` / `cancelled`), never the case.

**Labels** (`core/jobEvents/labels.ts`) are produced from the graph's node lifecycle events: every node emits `started` and a terminal `completed` or `failed`, localized to the request's language with an English fallback, and never with a payload. They are always on. The node's output is the operator's, and goes to OpenTelemetry instead (see Observability below).

**Lifecycle rules** worth knowing before you touch the channel:

- `CaseGenerationService.start()` reserves the jobId and opens the channel **synchronously**, before it returns, so a caller can subscribe before any node runs. `generate()` is just `start().result`.
- A jobId is an idempotency key: a duplicate is rejected with 409 while the job runs and for 10 minutes after (`TOMBSTONE_MS`), and never starts a second generation.
- A finished job's resources are released the moment it is terminal **and** its last subscriber has left, with a 5-minute backstop for a subscriber that never leaves. Its `complete` event stays behind as a tombstone for `TOMBSTONE_MS` — which is how "finished" and "never existed" get different answers.
- Generations share one FIFO limiter (`MAX_CONCURRENT_GENERATIONS`, default 4) across both transports. Excess jobs queue. Each job's `AbortController` is registered at submission, so a queued job can be cancelled before it ever takes a slot.

**Finding a job by id — the `JobDirectory` port** (`core/jobEvents/directory.ts`). REST's label stream and `DELETE` don't read the channel directly; they ask a directory, which `app.ts` picks (`selectJobDirectory`):

- **REST only:** the in-process directory. It sees only this replica's jobs, so running several REST replicas without NATS is not supported.
- **REST and NATS:** the NATS directory (`transports/nats/jobDirectory.ts`). It asks the replica that owns the job, so the answer is right whichever replica the HTTP request reached. NATS starts before REST for this reason; REST still closes first.

Ownership over NATS is **subscription interest**: the replica running a job subscribes to that job's `cases.cancel.<jobId>` and `cases.status.<jobId>` (`jobResponders.ts`), and nobody else does. A request for a job no replica knows gets NATS's own "no responders" immediately — never a wrong answer from a replica that merely doesn't own it.

**Reads** (diagnoses, procedures, features, allowed LLMs, graph structure) go through one `ReadModel` (`core/readModel.ts`) that both transports call, so their payloads are identical by construction.

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

`value` is the rendered artifact and `alt` a short description of what it conveys; the two are independent, and `alt` is authored by the planner, never by a provider. `textOf(parts)` is still the only path from content to a prompt, but it is MIME-dispatched: for a `text/*` part the prose lives in `value` and is decoded from it, and anything else falls back to `alt`. Add a MIME row to the table in `models/ContentPart.ts` (say, `application/pdf`) rather than reaching for a runtime registration API. **Bytes never reach a prompt or an LLM output schema.** Wire encoding (UTF-8 for `text/*`, base64 otherwise) lives in one place, `src/api/contentWire.ts`, and always carries `alt`.

A `Send` payload must never carry content-part bytes: LangGraph JSON round-trips them, so a `Uint8Array` arrives as a plain index-keyed object. Both translation phases fan out with plain edges for this reason.

### Data Layer

All lookups and caches are backed by an embedded SQLite database under `CACHE_DIR` (`node:sqlite`, WAL mode; Drizzle ORM, migrations in `drizzle/`).

The code is organised as vertical slices rather than one repo directory: shared infrastructure in `core/graph/persistence/`, each catalogue domain's repo beside its port adapters in `core/graph/catalog/<domain>/`, the symptom cache in `core/graph/symptoms/`, all composed by `core/graph/repos.ts`. **Every repo module exports a `createXxx(...)` factory and performs no I/O on import** — `repos.test.ts` enforces that.

`syncSource()` re-ingests a YAML file **only when its sha256 changed** since the last sync, with fingerprints kept in `_meta`. This matters: the largest source is a ~37k-entry translation file, and re-parsing it on every boot cost seconds.

Tables: `_meta`, `translation`, `diagnosis`, `predefined_item`, `symptom_cache`.

`translationStore.ts` is a cache-aside translation store shared by diagnoses, procedures, anamnesis categories and progress labels. In-flight work is deduped **per key**, and AI-generated translations are persisted with `source: "generated"` but **never written back to the YAML sources**.

### Data Files

`CATALOG_DIR` (default `data/`) holds the sources synced into SQLite at startup:

- `procedures.yml` / `proceduresTranslations.yml` — approved procedure names. Names may be prefixed `"Category: Name"`; uncategorized entries fall into a synthetic `"General"` bucket.
- `diagnosis.yml` / `diagnosisTranslations.yml` — ICD-11 diagnosis lookup
- `anamnesisCategories.yml` / `anamnesisCategoriesTranslations.yml` — anamnesis section definitions
- `labelTranslations.yml` — progress label translations
- `diagnosis_symptoms.json` — UMLS symptom floor per ICD code (loaded directly, not via the DB sync)

The generated database lives under `CACHE_DIR` (default `data/cache/`), deliberately a separate directory so a deployer can mount their own catalogues without clobbering it. `scripts/extract-icd11*.ts` build the diagnosis YAML from ICD-11 source data and are run manually.

## REST API

Requires the `REST` feature flag.

| Method   | Path                       | Purpose                                                                                  |
| -------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`              | Health check                                                                             |
| `GET`    | `/api/features`            | Active feature flags                                                                     |
| `GET`    | `/api/allowedLlms`         | Allowlisted LLMs (when `ALLOW_LLMS` is set)                                              |
| `GET`    | `/api/diagnosis`           | List predefined diagnoses                                                                |
| `GET`    | `/api/procedures`          | List predefined procedures                                                               |
| `GET`    | `/api/graph`               | Compiled graph topology — nodes, edges, English label keys — for this deployment's flags |
| `POST`   | `/api/cases`               | Generate a case — streamed as SSE, or blocking JSON (see below)                          |
| `GET`    | `/api/cases/:jobId/labels` | Watch any job's progress as SSE — `404` for an unknown job                               |
| `DELETE` | `/api/cases/:jobId`        | Cancel any job — `204` cancelled, `404` finished or unknown, `504` owner unreachable     |

A request body needs either `icd` or `diagnosis`; `generationFlags` defaults to all four fields and must name at least one; `difficulty` defaults to `medium`. `jobId` is optional — the server mints a UUID when it is omitted — and must match `[A-Za-z0-9_-]{1,128}`, because it is also a NATS subject token. The response echoes the resolved `language`, and content-bearing fields are wire-encoded (see Content Parts).

### `POST /api/cases`

One route, two response modes, chosen by `Accept`:

- `application/json`, or no preference — blocks and returns the case.
- `text/event-stream` — the job streamed back on the POST's own response:

```
POST /api/cases
Content-Type: application/json
Accept: text/event-stream

{"diagnosis": "Influenza", "generationFlags": ["patient"]}
```

```
event: accepted
data: {"jobId":"3fa2…"}

event: label
data: {"jobId":"3fa2…","nodeId":"…","status":"started","label":"Generating case outline", …}

: ping

event: label
data: {"jobId":"3fa2…","nodeId":"…","status":"completed", …}

event: result
data: {"patient": {…}, "jobId":"3fa2…","language":"English"}
```

`event: accepted` is written before any node runs, so the client never learns its jobId too late to follow it. A `: ping` comment is written every 15 seconds regardless of label activity, so a proxy never closes a connection that merely looks idle during a long node. On failure the stream ends with `event: error` instead of `event: result`. A duplicate `jobId` is a `409` on either path, answered before any stream opens.

**Disconnecting cancels the job**, on both paths. REST keeps no result store, so there is nothing to come back to; a client that must survive a dropped connection should use NATS.

### Watching and cancelling

`GET /api/cases/:jobId/labels` and `DELETE /api/cases/:jobId` work for **any** job — submitted over REST or NATS, running on this replica or, with NATS enabled, on another one (see Jobs and Transports above).

| Job state                        | `GET …/labels`                                                   | `DELETE`                 |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| running                          | `event: connected`, then `event: label`…, then `event: complete` | `204`                    |
| finished                         | `event: complete` with its outcome, then the stream ends         | `404` "already finished" |
| unknown                          | `404`                                                            | `404`                    |
| owner unreachable (NATS timeout) | `504`                                                            | `504`                    |

An observer can **watch** a job but not **collect** it: `complete` carries the outcome, never the case. A NATS job's result only ever goes to `cases.result.<jobId>`. An observer that attaches mid-job does not see labels emitted before it connected — the replay buffer that would fix this is #146.

## NATS API

Requires the `NATS` feature flag. Subjects are split on **durability**, not on feature: a JetStream stream's retention applies to everything its filter captures, so each retention policy gets its own stream (`transports/nats/subjects.ts`).

| Subject                                            | Kind                                 | Purpose                                                                                    |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `cases.request.generate`                           | JetStream `CASE_REQUESTS`, workqueue | Submit a job — the same body as `POST /api/cases`, with `jobId` **required**               |
| `cases.result.<jobId>`                             | JetStream `CASE_RESULTS`, limits, 1h | The job's case or error — replayable, by any number of readers                             |
| `cases.progress.<jobId>.{accepted,label,complete}` | core NATS, fan-out                   | The job's progress events — the same payloads as the SSE stream                            |
| `cases.cancel.<jobId>`                             | core NATS, request/reply             | Cancel → `{cancelled}`; "no responders" for an unknown or finished job                     |
| `cases.status.<jobId>`                             | core NATS, request/reply             | `{state: "active"}` or `{state: "terminal", complete}`; "no responders" for an unknown job |
| `catalog.diagnosis`, `catalog.procedures`          | request/reply, service `aetiomed`    | The same payloads as `GET /api/diagnosis` and `/api/procedures`                            |
| `meta.features`, `meta.allowedLlms`, `meta.graph`  | request/reply, service `aetiomed`    | The same payloads as `GET /api/features`, `/api/allowedLlms` and `/api/graph`              |

**Why the jobId is required.** It is the address of the result: a client subscribes to `cases.result.<jobId>` before or after submitting, and a server-minted id would be unfindable. A request without a valid one is terminated, not processed.

**Progress uses core NATS, not JetStream.** Labels are worthless once the job ends, so persisting them would cost a stream write per node for data with a useful life of milliseconds. Publishing to a subject nobody listens on costs almost nothing.

**The worker** (`cases.handler.ts`) pulls a request only once a generation slot is free, so a busy replica leaves queued work in the stream for other replicas. While a job runs it calls `msg.working()` every 20 seconds, which lets `ack_wait` stay at 60 seconds: a slow job is never redelivered to a second worker, and a crashed replica's job comes back within a minute. Domain failures are published as error results and acked; only a failed publish is nak'd for retry. A duplicate request is acked and ignored, never answered with an error that would overwrite the real job's result.

**The reads** run as a NATS micro-service (`@nats-io/services`, `metaService.ts`), so a NATS-only client can discover them through `$SRV.PING|INFO|STATS.aetiomed`.

**Upgrading from before the stream split.** The old `cases` stream (`cases.>`, workqueue) overlaps both new streams and cannot be migrated in place. Startup refuses to run while it exists. Delete it by hand — `nats stream rm cases` — after checking it holds no unprocessed requests.

## Observability

OpenTelemetry is the operator's channel, independent of `FEATURES` (`observability/otel.ts`):

- **One span per node** — timing, status, and attributes only: node id, job id, output size, provider/model.
- **One log record per completed node** — the node's output, capped at 50 KB, correlated to its span by `trace_id`/`span_id`. Output never goes into a span attribute: backends truncate attributes in the low kilobytes and bill by their volume.

The exporter is selected from the standard env, with no flag of our own:

| Configuration                          | What runs                                            |
| -------------------------------------- | ---------------------------------------------------- |
| `OTEL_SDK_DISABLED=true`               | nothing — the SDK packages are never even imported   |
| an `OTEL_EXPORTER_OTLP_*ENDPOINT` set  | batch processors + OTLP exporters (production)       |
| otherwise, `FEATURES` contains `DEBUG` | immediate processors + console exporters (local dev) |
| otherwise                              | nothing                                              |

`DEBUG` is the zero-infrastructure way to read a node's output during development: spans and log records print to stdout as they happen. Batched telemetry is flushed on shutdown.

A span exports when its node **ends**, so OTel shows a node only once it finishes — watching a job live is what the label stream is for.

## How to Test

```bash
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

The Vitest suite (~50 files) is co-located with its sources. It covers graph assembly, config parsing, catalogues and startup validation, the content-part wire codec, the translation store and split, language detection, the medical-basis and modality registries, the job channel and labels, OTel signals against the real SDK, the REST routes over real HTTP, and the no-I/O-on-import invariant.

**NATS integration tests** run against a real server and are skipped unless `NATS_TEST_URL` is set:

```bash
docker run -d -p 4222:4222 nats:2.10-alpine -js --user nats --pass nats
NATS_TEST_URL=nats://localhost:4222 pnpm test
```

CI starts that container before `pnpm test`, so they always run there — including a two-replica test of the NATS backbone.

**`tsconfig.json` excludes `**/_.test.ts`and includes only`src/\*\*/_`**, so `tsc`does not typecheck test files or`scripts/`. A type error in a test surfaces only if an assertion happens to catch it — verify tests by running them, not by trusting the build.

For pipeline changes, run a generation with `DEBUG` in `FEATURES` and read each node's output from the console exporter. `DEBUG` also adds `cors` and request logging to the REST app.

## Contributing Notes

- **Cite GitHub issues, not internal docs.** Design docs, issue write-ups and reviews live in `docs/design/`, which is gitignored. Under `docs/`, only `docs/graphs/` and `docs/bruno/` are tracked. Anything tracked — code comments, `CLAUDE.md`, the READMEs — refers to decisions by issue number (`#142`).
- **Stacked PRs** are managed with `gh stack`. A PR merged into a stack branch rather than `main` doesn't trigger its `Closes #N`, so put the keyword in the commit message too: commit keywords fire when the commit reaches `main`.

## Additional Tools

- **Bruno**: ready-made API requests in `docs/bruno/` for exercising the endpoints.
- **Graph diagrams**: `docs/graphs/case-graph.<topology>.svg`, regenerated by `pnpm graph:export`. `<topology>` is `none` or `translation-sandwich` — `PROCEDURE_PRESELECTION` swaps a strategy adapter without changing the graph's shape, so it does not get its own diagram.
