# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend (root)

```bash
pnpm dev          # generate registry + run with tsx watch (auto-restart)
pnpm build        # generate registry + tsc + tsc-alias
pnpm start        # run compiled dist/index.js
pnpm lint         # eslint
pnpm lint:fix     # eslint --fix
pnpm format       # prettier --write
pnpm graph:export # export LangGraph diagrams as SVGs
pnpm swagger      # regenerate swagger-output.json
pnpm generate     # regenerate src/extensions/_registry.ts (runs automatically in dev/build)
```

### Frontend (client/)

```bash
cd client && pnpm dev     # Vite dev server
cd client && pnpm build   # tsc + vite build
cd client && pnpm lint
```

### Infrastructure

```bash
docker compose up --build                    # full stack (server + NATS + Ollama + Redis)
docker compose up -d nats ollama redis       # infrastructure only, then run pnpm dev locally
```

### Graph diagram generation (requires Chrome via Puppeteer)

```bash
pnpm exec puppeteer browsers install chrome
pnpm graph:export
```

## Architecture

### Backend: Extension System

The server is built around a **plugin/extension architecture**. Extensions live in `src/extensions/` and are auto-discovered by `scripts/generate-registry.ts`, which writes `src/extensions/_registry.ts` (never edit this file manually). Each extension is defined via `defineExtension()` from `src/core/extension.ts`.

Key properties of each extension:

- `requiredFlags`: feature flags (from `FEATURES` env var) that must be set for the extension to load
- `dependsOn`: other extensions this one requires; the loader topologically sorts and cascade-skips
- `envSchema`: a Zod schema that parses its own slice of `process.env`
- `setup(ctx)`: async initialization; receives `ctx.config`, `ctx.bus`, `ctx.router`, and `ctx.dep(otherExt)`

Extensions communicate via a typed `EventBus` (`src/core/event-bus.ts`). Extensions augment the `EventMap` interface via TypeScript module augmentation to declare their events.

**Currently registered extensions:**
| Extension | Required Flags | Purpose |
|---|---|---|
| `core` | none | REST routes, LLM config, core case generation |
| `debugLogger` | none | Logs generation events to console |
| `nats` | `NATS` | Async case generation via NATS JetStream |
| `persistency` | `PERSISTENCY` | Saves completed cases to Redis |
| `swagger` | none | Serves Swagger UI at `/api/docs` |
| `tracing` | none | SSE-based live trace streaming per request |
| `tracingPersistency` | none | Persists trace logs to Redis |

To add a new extension: create `src/extensions/<name>/index.ts` exporting `extension`. The registry regenerates automatically on `pnpm dev` or `pnpm build`.

### Backend: Case Generation Pipeline (LangGraph)

All AI generation uses LangGraph. The top-level graph is built in `src/extensions/core/02graphs/caseGraph.ts` and orchestrates three subgraphs:

1. **`caseTranslationToEnglishGraph`** — translates input diagnosis/instructions if language ≠ English
2. **`caseGenerationGraph`** — the core generation pipeline (see below)
3. **`caseTranslationFromEnglishGraph`** — translates the finished case back to the target language

The `caseGenerationGraph` routes to:

- **`symptomsGraph`** — always runs first; fetches relevant symptoms for the diagnosis
- **`singleFieldGraph`** — used when only one `generationFlag` is requested
- **`multiFieldGraph`** — used for ≥2 flags; runs `fieldGenerationGraph` then `inconsistencyGraph`

Inside `fieldGenerationGraph`, after a CoT and outline are generated, patient/chiefComplaint/anamnesis generation fans out in parallel via `Send`, then fans back in before optionally generating procedures.

**Generation flags** (`src/extensions/core/models/GenerationFlags.ts`): `patient`, `chiefComplaint`, `anamnesis`, `procedures`. The request defaults to all four.

### Backend: AI Gateway Layer

`src/extensions/core/03aigateway/` contains one file per generated field. Each gateway function builds prompts, calls `getLLM()` / `getDeterministicLLM()` / `getCreativeLLM()` from `src/extensions/core/utils/llm.ts`, and wraps calls with `retry()`.

`getLLM()` supports three providers: `ollama`, `google`, `openai`. Provider/model come from env (`LLM_PROVIDER`, `LLM_MODEL`) or from per-request `llmConfig` passed via `RequestContext` (AsyncLocalStorage). The `ALLOW_LLMS` feature flag enables per-request LLM selection from an allowlist (`ALLOWED_LLMS=ollama:llama3.1,google:gemini-2.0-flash`).

### Backend: Numbered Directory Convention

`src/extensions/core/` uses numbered prefixes to indicate layer order:

- `01dtos/` — request/response schemas
- `01rest/` — Express routers
- `02graphs/` — LangGraph graphs
- `02services/` — business logic called by routers/graphs
- `03aigateway/` — LLM prompt/call functions
- `03repo/` — data access (YAML files, Redis)

### Backend: Data Files

`data/` contains YAML files loaded at startup:

- `procedures.yml` — predefined procedure names (when set, LLM must select from this list only)
- `diagnosis.yml` / `diagnosisTranslations.yml` — ICD-11 diagnosis lookup
- `anamnesisCategories.yml` — anamnesis section definitions

The `procedures/` directory (root level) contains categorized procedure YAML source files and scripts to extract/compile them into `data/procedures.yml`.

### Backend: Request Context

`runWithContext()` in `src/extensions/core/utils/context.ts` uses `AsyncLocalStorage` to propagate `traceId` and optional `llmConfig` through the entire async call chain without threading these through every function signature. Graph nodes access it via `runtime?.context` (LangGraph passes it) or `getRequestContext()`.

### Frontend

React + Vite + shadcn/ui + Tailwind v4. Uses `react-router-dom` for routing and **Dexie** (IndexedDB) for local persistence of cases and runs. The client calls the backend at the path configured in `client/src/config.ts`.

Client structure:

- `src/api/` — typed fetch wrappers for backend endpoints
- `src/db/` — Dexie database schema (cases + runs tables)
- `src/models/` — shared TypeScript types
- `src/pages/` — route-level components
- `src/components/` — shared UI components

## Environment Variables

| Variable          | Default            | Notes                                                                          |
| ----------------- | ------------------ | ------------------------------------------------------------------------------ |
| `PORT`            | `3030`             | Server port                                                                    |
| `FEATURES`        | `""`               | Comma-separated flags: `DEBUG`, `NATS`, `PERSISTENCY`, `TRACING`, `ALLOW_LLMS` |
| `LLM_PROVIDER`    | —                  | `ollama` \| `google` \| `openai` (required unless `ALLOW_LLMS`)                |
| `LLM_MODEL`       | —                  | Model name (required unless `ALLOW_LLMS`)                                      |
| `LLM_API_KEY`     | —                  | API key for Google/OpenAI                                                      |
| `LLM_URL`         | —                  | Override base URL (e.g. for local Ollama)                                      |
| `LLM_TEMPERATURE` | `0.7`              |                                                                                |
| `ALLOWED_LLMS`    | —                  | Format: `ollama:model1,google:model2` (requires `ALLOW_LLMS` flag)             |
| `NATS_URL`        | `nats://nats:4222` |                                                                                |
| `REDIS_URL`       | —                  | Required for `PERSISTENCY` extension                                           |

## Path Aliases

Backend: `@/*` → `src/*` (configured in `tsconfig.json` and resolved at runtime by `tsx`, at build time by `tsc-alias`).

Frontend: `@/*` → `client/src/*` (configured in `client/vite.config.ts`).
