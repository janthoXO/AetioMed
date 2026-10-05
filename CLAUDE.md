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
pnpm graph:export # export LangGraph diagrams as SVGs (scripts/exportGraphs.ts)
pnpm db:generate  # drizzle-kit generate — regenerate SQL migrations in drizzle/
```

`pnpm format`/`format:check` only cover `src` — markdown, `package.json`, the workflows and
`scripts/` are not format-checked. Format those manually with
`npx prettier --write <path>` when touched.

### Infrastructure

```bash
docker compose up --build                    # server + ollama (NATS via profile)
docker compose --profile NATS up -d          # infrastructure only, then run pnpm dev locally
```

`nats`/`nats-box` are behind the `NATS` compose profile.

### Graph diagram generation (requires Chrome via Puppeteer)

```bash
pnpm exec puppeteer browsers install chrome
pnpm graph:export
```

## Internal documentation

Design docs, issue write-ups and reviews go in **`docs/design/`**, which is gitignored — they are
never committed. Only `docs/graphs/` (generated diagrams) and `docs/bruno/` (the API collection)
are tracked under `docs/`; `.gitignore` whitelists exactly those two. The public record of a
decision is its **GitHub issue**, so cite issues (`#142`), never a `docs/design/` path, from
anything tracked — code comments, this file, the READMEs.

## Architecture

This is a backend-only repository (no frontend lives here). Node >= 24.21, pnpm.

### Composition Root

There is no plugin/extension framework — `createApp()` in `src/app.ts` constructs
everything explicitly, in order:

1. parses `FEATURES` and the graph config from `process.env`
2. resolves `CATALOG_DIR` / `CACHE_DIR` (`adapters/persistence/paths.ts` — pure functions taking
   the environment as an argument; nothing under `src/core/` reads `process.env`) and builds the
   adapters: repos (`adapters/repos.ts`'s `createRepos`), the LLM port (`adapters/ai/llm.ts`),
   the `Yaml*` catalogs (`adapters/catalog/index.ts`)
3. `initGraph()` (`src/core/graph/index.ts`) takes those ports, builds the `GraphRuntime` and the
   compiled graph; `createApp()` then validates the catalogues (`validateCatalogsOrExit`)
4. `createCaseGenerationService(graph, bus, jobEvents, opts)` — `opts` is just the shared
   generation limiter's size (`maxConcurrent`, `MAX_CONCURRENT_GENERATIONS`); the service is
   stateless between calls (#159), so there is nothing else to wire in here
5. starts the transports whose flags are set — **NATS before REST** (issue #145): REST's job
   directory (below) may ride on NATS's connection, so NATS must already be up by the time
   `startRestServer` is called. Shutdown order is unaffected — REST still closes **first**,
   before NATS goes away, so nothing stops accepting client work before it stops being able to
   answer it

It also owns shutdown (issue 18): `createApp()` returns `{ bus, shutdown }`, where `shutdown()`
closes everything it started in the **reverse** of construction order — REST, then NATS, then
the DB last — bounded by a 5-second deadline (`src/shutdown.ts`'s `installSignalHandlers`,
wired up by `src/index.ts`). No module under `src/core/graph/` or `src/transports/` registers
a process signal handler any more; each returns a closer instead.

**Core is a clean hexagon (#188).** `src/core/` holds domain logic and ports only; every I/O
adapter lives under `src/adapters/` — `ai/` (LangChain chat-model factory), `catalog/<domain>/`
(repos plus `Yaml*`/`InMemory*` port adapters, startup validation), `persistence/` (SQLite,
Drizzle, translation store), `symptoms/`, `language/` (tinyld), `repos.ts` — and only
`src/app.ts` wires them in. `importBoundary.test.ts` fails on any core production module that
imports `@/adapters`, `@/app`, `fs`/`path`, `node:sqlite`, `drizzle-orm`, `tinyld` or a LangChain
provider package or `@langchain/core` (the LLM port speaks only core types since #190);
`@langchain/langgraph` stays for good — it is the engine graphs are written in, not an
I/O adapter.

**`GraphRuntime`** (`src/core/graph/runtime.ts`) is the single seam graph construction goes
through: the LLM port, the five catalogs, a logger and a clock. It is captured by **closure
at graph-assembly time**, not threaded through node signatures and not carried on
LangGraph's runtime context. Nothing under `src/core/graph/` imports a mutable module
singleton.

**`CaseGenerationService`** (`src/core/caseGenerationService.ts`) is what both transports
call. It owns ICD→name resolution, jobId minting, `runWithContext`, terminal event emission
(`Generation Completed` / `Failure` / `Cancelled`) and error→status mapping, and returns a
job shape (`{ jobId, status, case?, error? }`) rather than a bare `Case`. Transports are
protocol translation only.

`start(req, opts?)` is the synchronous primitive: it reserves the jobId and opens its event
channel **before returning**, handing back a `StartedJob` (`{ accepted: true, jobId, result:
Promise<CaseGenerationResult> }` or `{ accepted: false, jobId, result: CaseGenerationResult }`
for a duplicate). `generate(req, opts?)` is just `start(req, opts).result` awaited. The split
exists for REST's POST stream (#143): a caller can subscribe to the job's events before any
node runs, and learns about a duplicate jobId before it has committed to a response format
(SSE headers already flushed vs. a plain JSON 409).

It passes `generationFlags` through unchanged. For a field the caller did not request, the
blinded solver reads that field's **outline section** instead of a rendered field
(`presentationSections`, `shared/outline/segments.ts`, #205): Patient, Chief complaint and
Anamnesis only (with its `### category` subsections), sliced by position now that the outline is
segments (#159) and handed to `renderCase` as `outlineSections`. Never `## General` — the home of
every pedagogical note (hallmarks, distractors, difficulty reasoning); the outline prompt and
judge keep the field sections to facts only — and never `## Procedures`, the results strategy,
written knowing the diagnosis. A field that _is_ generated wins over its section (`altOf`).

**The generator is stateless between calls (#159).** A call carries everything it needs — the
request, and optionally a `plan` — and nothing survives it: no job record, no checkpoint, no
stored API key. `start(req, opts?)` runs the plan graph and, unless the request already carries
a `plan`, stops there in plan mode (`status: "planned"`, the outline handed back in the request
language) or continues straight into the case graph in normal mode (`status: "done"`); a request
that does carry a `plan` skips planning entirely and generates the case from it — the same
jobId as the plan's own call is fine, since the channel allows exactly this one reuse (see
`core/jobEvents/channel.ts`'s `open()` below). `opts.onPlan` is called with a normal-mode job's
plan (`PlanPayload`) as soon as it exists, while the case is still being generated, so a
transport can hand it over on the way without waiting for the result; a plan-mode job's plan is
its result instead, never delivered through `onPlan`. `CaseGenerationResult.status` is one of
`"done" | "planned" | "failed"` — `"planned"` is where a plan-mode call without a plan stops.
Recovering a crashed call is the transport's job, not the service's: NATS redelivers an unacked
request (see the NATS Layer section below), and a REST client just resends. Every per-request
`llmConfig` (API key included) lives only on that call's `AsyncLocalStorage`-bound context —
nothing is ever written to disk for it to survive with.

**`src/core/jobEvents/`** (#139) is the core-owned per-job event channel:
`createJobEventChannel()` builds one instance, constructed once in `app.ts` and handed to
`CaseGenerationService` (which `open()`s it before its first await and `close()`s it with the
job's outcome on every path) and to every transport, which only ever `subscribe()`s. Event
names double as the SSE `event:` name on REST and the last subject token on NATS
(`cases.progress.<jobId>.<name>`), so no adapter needs a name-mapping table. `wireLabels`
(`core/jobEvents/labels.ts`) also lives in core now, not in `tracing/` — it turns the graph's
node lifecycle bus events into localized `label` events, using the `language` now carried
directly on the bus event (set by `traceNode` from ALS) rather than a per-job language map.
`channel.ts`'s `peek(jobId)` (#145) is `state`'s sibling: it also returns a terminal job's
`complete` event, but — unlike `subscribe()` — never opens a subscription, so a status check
never keeps a job's resources alive.

**The `JobDirectory` port** (`core/jobEvents/directory.ts`, #145) answers
"watch/cancel this jobId, wherever it runs" — the seam that lets a REST client observe or cancel
a job that a **different replica** accepted. `watch(jobId)` returns `{state: "active", listen(onEvent)
=> stop}` (subscribed and buffering **before** the caller decides its response, so no event
between "learn the state" and "attach a listener" is lost — `createBufferedWatch` is the shared
buffer-then-replay machinery both implementations use), `{state: "terminal", complete}`, or
`{state: "unknown"}`; `cancel(jobId)` returns `"cancelled" | "finished" | "unknown"`. Both
methods are `Promise`-returning and can **reject** — that means "the answer could not be
obtained" (a NATS timeout), which is a different failure mode from `"unknown"` ("nobody has this
job") and maps to a 504, not a 404. A watched job's events are deliberately narrow: never
`accepted`, and `complete`'s data never carries the case — **watch, not collect**: an observer is not the requester, and the result only ever goes back to whoever started
the job.

Two implementations, chosen once in `app.ts`'s `selectJobDirectory({ features, local, nats })`:
`createLocalJobDirectory(channel, cancel)` (in-process, the only option with `NATS` unset — a
single replica is then a documented deployment constraint) and, per #145,
`transports/nats/jobDirectory.ts`'s `createNatsJobDirectory(nc)`, selected only when **both**
`REST` and `NATS` are enabled and NATS actually connected (a connected-but-then-lost NATS falls
back to local with a `console.warn`, never a silent wrong answer). **Direction matters: REST
depends on NATS here, only through this one piece of composition — NATS never imports REST**
(`importBoundary.test.ts` scans every production module under `src/transports/nats/` for this).
Known gap, tracked as #146: an observer attaching mid-job sees no replay of labels emitted
before it connected — only `createBufferedWatch`'s own since-`watch()` buffer, not a full
history.

**Modules under `src/transports/` and `src/observability/`** are ordinary modules with a start
function, not plugins: `transports/rest/` (`createRestApp`/`startRestServer` — see the REST
Layer section below for its always-on routes), `transports/nats/` (`startNatsTransport`), and
`observability/` (`otel.ts`, `tracePayload.ts` — the OTel operator channel; see below). `src/api/`
holds the shared request/response Zod schemas.

The typed **`EventBus`** (`src/core/event-bus.ts`) is kept — it genuinely decouples the label
and OTel channels from the graph. Modules augment its `EventMap` interface via TypeScript
module augmentation.

**Labels and OTel spans (#139/#140/#141) are two channels, not one — the axis of the split is
payload, not event count** (#140).
They differ in audience, content, language and gate:

- **Labels** — end user. One short, localized phrase per node execution, emitted on both
  "Node Started" and every terminal status ("Node Completed"/"Node Failed") — never node
  output, never a payload. Always on (not feature-flagged): `src/core/jobEvents/` owns the
  per-job channel (`channel.ts`'s `createJobEventChannel`) and the label producer
  (`labels.ts`'s `wireLabels`), served over SSE (`GET /api/cases/:jobId/labels`,
  `transports/rest/routes/labels.router.ts`) and, per #144, NATS.
- **OTel spans** — operator, cross-request analysis. One span per node, started and finished,
  carrying **attributes only** — `aetiomed.node.id`, `aetiomed.job_id`, `aetiomed.node.output_bytes`
  (a size, never the payload), `aetiomed.llm.provider`/`model`, status — never node output
  itself (#141). OTLP-exported
  only, never SSE/NATS. Gated by the standard
  `OTEL_SDK_DISABLED`/`OTEL_EXPORTER_OTLP_ENDPOINT`(`_TRACES_ENDPOINT`/`_LOGS_ENDPOINT`)/`OTEL_SERVICE_NAME`
  — its own axis, independent of any `FEATURES` flag except `DEBUG`, which only picks the
  exporter (below), never gates the channel itself. `src/observability/otel.ts` is the one
  place `@opentelemetry/*` is imported and these env vars are read; core only knows the
  `NodeTracer`/`NodeSpan` port (`core/graph/utils/nodeWrapper.ts`) — the same
  port-owned-by-core/adapter-lives-outside inversion `core/jobEvents/` uses for labels.
- **OTel logs — the node's output** (issue #141). `NodeSpan.setOutput(output)` hands the
  adapter the node's already-sanitized result (every `ContentPart` reduced to `{ type, bytes }` — `sanitizeForTrace`,
  `core/graph/utils/traceSanitize.ts`); on `end()`, if an output was set, the adapter emits one
  correlated **log record** (`Logger.emit`, `@opentelemetry/api-logs`) whose `context` carries
  the span (`trace.setSpan`), so a backend joins the two by `trace_id`/`span_id` — before
  ending the span itself. The log's body is `buildTracePayload(output)`'s value as JSON, or
  `{ truncated: true, bytes, preview }` past `MAX_TRACE_PAYLOAD_BYTES`
  (`src/observability/tracePayload.ts`); a failed node emits no output log. **Why a log record
  and not a span attribute:** backends index every span attribute for filtering, so they cap
  attribute values in the low kilobytes and truncate/drop past it (case outlines are large
  markdown — that failure is silent), and billing is per-attribute; the logs signal takes a
  body of arbitrary size and is exactly what a correlated "node output" message is. No span
  attribute may ever carry output text. A `ContentPart` reaches a log only as
  `{ type, bytes: value.byteLength }` (#191) — no raw bytes, no rendered text, and no `alt`
  (the planner nodes and `translate_rest` already log it); to see what a renderer produced, read
  the API response, which carries every `value` in full.
- **Exporter selection — no dedicated flag** (`selectExporterMode`, `observability/otel.ts`):
  `OTEL_SDK_DISABLED === "true"` (that literal only) → nothing constructed at all; else any of
  `OTEL_EXPORTER_OTLP_ENDPOINT`/`_TRACES_ENDPOINT`/`_LOGS_ENDPOINT` set → `BatchSpanProcessor`
  - `OTLPTraceExporter` and `BatchLogRecordProcessor` + `OTLPLogExporter` (production; needs a
    collector/backend listening there); else `FEATURES=DEBUG` → `SimpleSpanProcessor` +
    `ConsoleSpanExporter` and `SimpleLogRecordProcessor` + `ConsoleLogRecordExporter`
    (zero-infrastructure local dev — JSON to stdout, immediately); else nothing constructed —
    **behaviour change**: an unset endpoint used to still build a real SDK that tried (and
    failed) to export to `localhost:4318`. Every SDK package (`sdk-trace-node`, `sdk-trace-base`,
    `sdk-logs`, both OTLP exporters, `resources`) is reached only through a guarded dynamic
    `import()`, so "nothing constructed" means the packages are never even loaded; only
    `@opentelemetry/api`/`api-logs` (pure interfaces and no-op globals) are static imports.
    `createOtelNodeTracer({ debug })` returns `{ tracer, shutdown }`; `app.ts` registers
    `shutdown` as a closer, after NATS and before the DB, so batched spans/logs flush once
    producers have stopped but before the process exits.
- **Liveness caveat.** A span exports once, on `end()` — there is no "span started" wire
  event, so nothing appears for a node until it finishes; watching a running generation live
  is the label channel's job, not OTel's.

Both channels key a node by its **LangGraph node id** (`nodeId`, matching `GET /api/graph`
below), which is the qualified path LangGraph itself uses for a nested node (e.g.
`case_phase:presentation_phase:chief_complaint_phase:plan_content`), not the bare
name passed to `traceNode` — two different subgraphs reuse bare names like `plan_content` and
`render_parts`, so `TraceNodeFn.scope()` (`nodeWrapper.ts`) threads the same qualification
LangGraph computes at every point a compiled subgraph is mounted (issue 15 §3/§4, still true).

**`GET /api/graph`** (`core/graph/structure.ts` + `transports/rest/routes/graph.router.ts`) is
always on, following labels' gate: it returns the deployment's actually-compiled topology —
nodes (with English `labelKey`) and edges from `getGraphAsync({ xray: true })`, the same call
`scripts/exportGraphs.ts` uses for mermaid diagrams. Label keys, not localized strings: the
structure is language-independent and cacheable; a client wanting localization already has it
on the label channel, per job. Since #159 the pipeline is two top-level graphs (plan, case), so
`buildGraphStructure` returns their **union**, in execution order — plan, then the sandwich's
middle translation graphs (`outlineOut`/`reviewIn`, when compiled in), then case — with no edge
between them: the job service, not a graph, runs one after the other, so there is nothing to
draw there.

**Two defects fixed alongside issue 15, both still true today:** `traceNode` (`nodeWrapper.ts`)
wraps the node call in `try`/`catch` — a throwing node used to emit "Node Started" and nothing
terminal; it now also emits "Node Failed" and rethrows. The per-job channel
(`core/jobEvents/channel.ts`, #139) does not tear down on a hardcoded timer — it tears down
when the job reaches a terminal state **and** its last consumer has disconnected
(`subscribe`/the returned `unsubscribe`), with a generous 5-minute backstop kept only for a
consumer that never disconnects. A finished job is then remembered as a tombstone (its
`complete` event only, nothing else) for 10 minutes, which is what lets "finished" and "never
existed" get different answers and makes a reused jobId a detectable 409 duplicate.

Open question, deliberately unsolved: a checkpoint-resumed node (F09) re-executing produces
two OTel spans for one logical step.

### Catalog Layer

**The procedure catalogue is a tree, not a flat list.** `procedures.yml` parses into a
`ProcedureTree<{ name }>` (`shared/domain/ProcedureTree.ts`) — a uniform recursive shape,
`{ categories: ({ name } & ProcedureTree)[], procedures: Leaf[] }`, categories nested to any
depth, root and every category sharing the same shape. A procedure's identity is a `ProcedureRef`
(`{ path, name }` — category names from the root, then its own name), compared/deduped/excluded
only by `refKey(ref)` (`JSON.stringify([...path, name])`, built, never parsed) — a
`"Category: Name"` string is never built or split anywhere in the pipeline any more. Prompts show
`refLabel(ref)` (`Cardiology › Resting ECG`). `duplicateSiblings(tree)` (sibling names — category
and procedure names share one namespace at each level) must be empty; caught at startup, see
below. `ProceduresRepo.getProcedureTree()` replaces the old flat `getEffectiveProcedureList()`;
`ProcedureCatalog.tree()`/`.candidates()` replace `list()`/`categories()`/`scope()`.
`ProcedureCandidates` (`catalog/procedures/candidates.ts`) builds a nested pick grammar mirroring
the tree (categories keyed by exact name, `.optional()` at every level) and `assemble()` walks a
model's pick back into `ProcedureRef[]`, dropping anything outside the tree. Freeform (no
catalogue) is unchanged: the model invents names, refs come back with `path: []`.

`src/core/graph/catalog/` owns the catalogue concept behind ports (`ProcedureCatalog`,
`AnamnesisCatalog`, `LabelCatalog`, `DiagnosisCatalog`, `OutlineHeadingCatalog` in `ports.ts`). The adapters live in
`src/adapters/catalog/<domain>/` (`procedures/`, `anamnesis/`, `labels/`, `diagnosis/`,
`outlineHeadings/`), each
holding that domain's repo (`repo.ts`) and its port adapters (`catalog.ts`: a `Yaml*` adapter
over the repo instance and an `InMemory*` adapter for tests and `scripts/exportGraphs.ts`),
re-exported from the slice's `index.ts`. `adapters/catalog/index.ts` composes all five `Yaml*`
adapters into the `GraphRuntime["catalogs"]` bundle (`createYamlCatalogs(repos)`).

Nothing in core reaches past a port (#188). The translation accessors translate-out needs are on
the ports themselves: `ProcedureCatalog.translation`/`saveTranslations` (keyed by
`nodeKey(path)` — shared by categories and procedures since sibling uniqueness makes the key
space unambiguous) and `AnamnesisCatalog.fromEnglish`/`saveTranslations`, next to
`DiagnosisCatalog.toEnglish`/`saveTranslations`.

`ProcedureCandidates` (`catalog/candidates.ts`, stays in core: it is domain logic) is where flat-vs-grouped
presentation, category scoping, exclusion of already-ordered procedures, the literal-union
grammar and `"Category: Name"` reassembly live — the AI gateway only calls `render()`,
`grammar()` and `assemble()`.

`adapters/catalog/startupValidation.ts` checks every translation file against its base catalogue at startup
and exits non-zero naming every offending key, with a Levenshtein suggestion. **Diagnosis is
exempt** — its store is also an input index for user-supplied diagnosis names, so keys
outside the curated catalogue are legitimate. Validation runs after graph construction
because the labels catalogue's base key set is `getKnownLabels()`, populated by `traceNode`
as the graph is built.

### Case Generation Pipeline (LangGraph)

All AI generation uses LangGraph. Graphs live in `src/core/graph/`. Since #159 the
pipeline is **two top-level graphs, not one** — `assembleCaseGraphs(deps, flags)` (`assemble.ts`,
now plural) builds a **plan graph** that ends with an outline and a **case graph** that starts
from one. The seam between them is where a plan-mode call stops and hands the outline back —
`CaseGenerationService` never runs the case graph in that call; normal mode runs straight from
one into the other in the same call. With `TRANSLATION_SANDWICH` on:

- **plan graph**: `01-translate-in/` (mounted at `START`, conditional — see
  below) → `plan_phase` (mounts `02-plan/02-outline/`'s outline ⇄ judge loop; see below)
- **case graph**: `case_phase` (mounts the field fan-out and procedures; see below) →
  `05-translate-out/` (conditional on the response actually needing translation)

`01-translate-in/` translates `diagnosis.name` and, alongside it, every
`userInstructions` value, to English — two disjoint-channel `Send` nodes
(`translate_diagnosis`/`translate_user_instructions`) run in parallel from `START`, each writing
only its own top-level field, no merge needed. `05-translate-out/` is three
nodes, not a chain (issue 12): `translate_defined` and `translate_rest` run in parallel from
`START`, each writing only its own state channel (`definedTranslations`/`restTranslations`,
never `case`); `translate_merge` is the **only** node that writes `case`, applying both maps to
it. See "Content Parts" below for why this replaced a whole-case, single-LLM-call translator.

With `TRANSLATION_SANDWICH` off, both translation phases are absent (see the assembly rule
below), and — with it on — two more single-node graphs, `outlineOut`/`reviewIn`
(`buildOutlineTranslationGraph`, `03-outline-translation/`), are compiled alongside the
plan and case graphs but mounted in neither: they are invoked directly by
`CaseGenerationService`, through `graph.translateOutline(values, direction)`, and only for a
plan-mode call in a non-English language — never by normal mode, and never with the sandwich off
(plan mode then generates and shows the outline directly in the request language). `outlineOut`
translates a fresh outline out to the requester when a plan-mode call stops without a plan;
`reviewIn` translates a plan handed back in a later call back to English before it is checked
and generated from (see "Outline segments" below for the per-segment cache that skips
re-translating an untouched segment). They stay two separate compiled graphs, not two nodes of
one, because they never run in the same call — see "Composition Root" above for the stateless
call shape.

`planCase(opts)` and `renderCase(opts)` are the two entry points `CaseGenerationService` calls —
`planCase` invokes the plan graph and returns `{ diagnosis, userInstructions, basisFragments,
outlineSegments, outlineAccepted }` (all in the working language: English after translate-in);
`renderCase` invokes the case graph from a prompt-ready outline string (`joinOutline`, see
"Outline segments" below) and returns the finished `Case`. The service throws
`OutlineNotAcceptedError` in normal mode when the judge loop never accepted the outline — a
**behaviour change** (#159): this used to render anyway. `language` is **not** threaded into
graph state or LangGraph's own runtime context — by the time either entry point runs,
`runWithContext` (called by `CaseGenerationService`) has already bound it on
`AsyncLocalStorage`, which is what the translation-routing edges and every generation gateway
actually read. `callerSuppliedFreeText` **is** threaded into the plan graph's state — see the
Language section below for why the two differ.

**`plan_phase`** (`buildPlanningPhaseGraph`, `02-plan/graph.ts` / `04-case/graph.ts`) runs up to two
steps — the first compiled in only when the medical-basis registry is non-empty:

- **`basis_resolve`** — runs first, and only when the medical-basis registry (`src/core/graph/02-plan/01-basis/`) is non-empty: an absent registry means an absent node, not a node that runs and does nothing. The registry is a plain list built once in the composition root (`graph/index.ts`'s `createMedicalBasisRegistry`), **not** a second compile-time flag — its _size_ decides whether `basis_resolve` is compiled in, the same rule `assemble.ts` applies to `TRANSLATION_SANDWICH`. Every registered `MedicalBasisProvider` (`02-plan/01-basis/ports.ts`) returns plain text, or nothing when it has none for this query (not rendered), and is run concurrently; their fragments are concatenated in **registry order** (not completion order) — there is no LLM call spent deciding which source to use; a throwing provider is logged and skipped, a hanging one is bounded by the request's abort signal. `02-plan/01-basis/render.ts` renders the concatenated fragments into one "Medical basis" section of the plan's **user** message only (never the system message), each fragment fenced and headed by the provider's `description` alone — the fence delimiters are escaped if they appear inside a fragment's own content, so a fragment can never close its own fence early. The registry is `umlsSymptoms.ts` then `llmSymptoms.ts`: `umlsSymptoms.ts` is UMLS-only — a static symptom floor per ICD code, nothing else — and `llmSymptoms.ts` is its fallback, running only when UMLS has nothing for the ICD code, cache-aside (skips the LLM on a fresh cache hit).
- **`outline_phase`** (mounts `02-plan/02-outline/`'s `buildPlanGraph`) — generates the tag-delimited outline (see "Outline segments" below), then a combined evaluate ⇄ revise `Command` loop (max 2 iterations, `outline_evaluate`/`outline_regenerate`) judging obviousness AND clinical consistency in one LLM call. On the iteration cap, the loop ends with `outlineAccepted: false` rather than looping forever — what that means is the caller's call: normal mode throws `OutlineNotAcceptedError` (a behaviour change, #159 — it used to render anyway), plan mode shows the outline to the reviewer regardless, with no marker, and lets them judge consistency themselves. `languageOf(state, runtime)` binds the outline and its judge prompts to the request language (`boundLanguage(runtime)`) only in plan mode; normal mode passes no language (English) — independent of the sandwich, which controls the case-generation runtime's `languageOverride`, not this phase's audience.

**`case_phase`** (`buildCaseGenerationGraph`, `02-plan/graph.ts` / `04-case/graph.ts`) takes an
outline as **input** (no outline generation happens here any more — that moved to
`plan_phase` above) and runs up to two phases:

- **`presentation_phase`** — `04-case/01-presentation/` fans the outline straight out via `Send` to `patient_generate` / `chief_complaint_phase` / `anamnesis_phase` (gated per `generationFlags`), joining at `case_fan_in`. There is no post-fan-out consistency check — that judgment already happened on the outline, in `plan_phase`, before any field exists. `chief_complaint_phase` and `anamnesis_phase` are **compiled subgraphs** (`chiefComplaint/index.ts`, `anamnesis/index.ts`), not function nodes — see "Modality Planning and Rendering" below for their internal `plan_content → render_parts` shape. `patient_generate` stays a plain function node: `patient` is not a `ContentPart[]` field (it stayed a structured `Patient` object through issue 11), so there is nothing for a modality provider to render — the `Send` payload (`{ diagnosis, outline, userInstructions }`) is identical across all three targets either way, whether the target is a function or a compiled subgraph.
- **Subgraph output schemas (issue 17).** A compiled subgraph mounted with `addNode` writes back its **entire state schema** by default, not just the channels its nodes actually touched. `chief_complaint_phase` and `anamnesis_phase` are `Send`-fanned out in parallel above, so both writing back the whole state made their shared `diagnosis`/`userInstructions`/`outline` `LastValue` channels each receive two values in one superstep — `INVALID_CONCURRENT_GRAPH_UPDATE` on every default request. The rule: **a compiled subgraph's state schema is its input surface; its `output` schema is its write surface, and the write surface must be declared explicitly** — every `addNode`'d or `.invoke()`d subgraph in `02graphs/` gets an `output` built with `.pick()` off that graph's own state schema (never a hand-written duplicate, so the picked channel keeps the identical reducer registration). `chiefComplaintGraph`/`anamnesisGraph` output `{ case }`; `presentation_phase` (`buildFieldGenerationGraph`) outputs `{ case }` only now (#159 — it used to also output `outline`, when `04-case/02-procedures/`'s `result_step` still read it out of `case_phase`'s own state; the outline reaches `renderCase` as a plain string input instead); `outline_phase` (`buildPlanGraph`) outputs `{ outlineSegments, outlineAccepted }`, and `plan_phase` around it outputs the same `{ outlineSegments, outlineAccepted }`; `procedures_phase`/`case_phase`/`translate_out_phase` output `{ case }`; `translate_in_phase` outputs `{ diagnosis, userInstructions }`, since translating those two is its entire job; the blinded solver's child graph (`.invoke()`d, not mounted) outputs `{ move }`. `case_fan_in` used to be `passthrough` (echoing the whole incoming state as its "update"); a join point produces no update, so it is now a node returning `{}`.
- **`04-case/02-procedures/`** — only when the `procedures` flag is set. A **blinded solver** loop (max 6 iterations) with 4 nodes: `blinded_step` orders procedures without knowing the true diagnosis, `result_step` _plans_ their results non-blinded (issue 21 — nothing renders inside the loop; see "Modality Planning and Rendering" below), and the terminal `render_results` renders every procedure's parts in one grouped pass and is the only node that writes `case.procedures`; when the solver commits to a diagnosis, an LLM judge checks the match (loop continues with `ruledOutDiagnoses` on mismatch). On exhaustion, a `bridge` node generates confirmatory procedures for the true diagnosis. The approved catalogue is presented (and picked) as its category tree: the pick grammar mirrors the tree (`{ procedures?: [...], categories?: { "<name>": <same shape> } }`), for both the blinded pick and the (non-blinded) bridge pick. Procedure selection is a `ProcedureStrategy` port (`04-case/02-procedures/solver/`: `ports.ts`, `drillDownPick.ts`) — `blinded_step` and `bridge` call `strategy.nextStep()` / `strategy.bridge()`; `DrillDownPick` (the only implementation; the port stays as the graph tests' seam for fake strategies) is constructed directly at graph-assembly time. It picks in one call when fewer than `MAX_PICK_CANDIDATES` (255) procedures are left; otherwise `drillDown` narrows first, one `selectProcedureLevel` call per level: the model keeps whole categories (shown with size and sample names) and single procedures, kept procedures stay, kept categories open one level deeper, until the pool is under the threshold or nothing is left to open — then the pick runs over that pool. Only the first call of a blinded step may diagnose (the level selection when there is one, else the pick), and never before the first batch has been ordered: a correct first-step guess would otherwise end the loop with `case.procedures` empty. The bridge narrows the same way with the diagnosis known. Known ceiling: a single category with ≥ 255 direct procedures still produces an oversized level. The blinded step's own compiled child graph (built once, invoked — not added as a node — from inside `blinded_step`) has a state schema that structurally omits `diagnosis`: the `BlindedView` type already makes passing it a compile error, and the child graph is a runtime backstop on top of that (LangGraph filters input against a graph's state schema before it reaches a channel). `matchDiagnosis` stays in the parent node, outside the blinded path, since it's an oracle call. Additional guard: already-ordered procedures are excluded from every candidate list/grammar (duplicate orders are impossible by construction).

### Outline segments

Since #159 the outline is never diffed against a remembered copy — the generator keeps no
memory of a plan between calls, so there is nothing to diff against. It is a **positional
segment array** (`OutlineSegments`, `graph/shared/outline/segments.ts`) instead: the LLM emits
markdown with its fixed (server-owned) headings wrapped in `<fixed>…</fixed>` tags, and
`parseTaggedOutline`/`renderTaggedOutline` convert between that and the canonical shape —
`segments.length` is always odd, even indices (0, 2, …) are editable (`fixed: false`, possibly
empty string), odd indices are fixed (`fixed: true`). The skeleton (`outlineSkeleton`/
`checkSkeleton`) is server-owned and always has the same five top-level sections — `## General`,
`## Patient`, `## Chief complaint`, `## Anamnesis`, `## Procedures` — plus, between Anamnesis and
Procedures, one `### <category>` heading per configured anamnesis catalogue category (or
LLM-named ones, in order, when the catalogue is freeform).

**A plan handed back into a later call is validated, not diffed.** `checkSkeleton` is the one
check a plan must pass — both freshly generated (the retry signal for an LLM that emits a
malformed or incomplete skeleton) and handed back in (`INVALID_PLAN`, a 400, if it fails): the
generator never saw this plan before, so there is nothing to compare it against, only its own
shape to validate. Before that check, `restoreSkeletonHeadings` puts the server's own English
headings back into a plan translated in from the request language, by position — a translated
heading need not round-trip to the exact English string `checkSkeleton` expects, so this is what
lets the check still pass. `isCanonicalShape` (checked at the request-schema boundary, before any
of this) is the one thing a handed-back plan must prove even earlier: that it still alternates
editable and fixed segments correctly. `joinOutline` — the prompt-ready text every downstream
generator reads — always escapes any `<fixed>`/`</fixed>` typed inside an editable segment, so a
handed-back plan can never re-create outline structure that only the server is allowed to own.

**Only in plan mode, and only with the sandwich on, does a plan's body cross the language
boundary at all** (`translatesPlan` in `caseGenerationService.ts`; its headings are localized in
any non-English plan mode, `localizesPlan` — see below): a plan-mode call without a plan
translates its fresh English outline out to the request language before returning it
(`translatePlanOut`); a plan-mode call carrying a plan translates it back to English
(`translatePlanIn`) before validating and generating from it. Normal mode never translates a
plan — it is always English, in and out. **A per-replica cache keyed on `(language, translated
text)`** (`planCache`, TTL `PLAN_CACHE_TTL_MS` = 24h) is what lets an untouched segment come back
as its original English rather than being re-translated: `translatePlanOut` records
`translated → english` for every segment it produces, and `translatePlanIn` only calls the
translator for the segments that miss. This is process-local, in memory — a restart or another
replica just translates again (ponytail: share it, e.g. NATS KV, if that ever shows in cost).

**Headings are dictionary-translated, never free-translated.** Generation always reproduces the
English skeleton; a non-English plan-mode plan gets its server-owned headings swapped in
afterwards, by `localizeHeadings` (`03-outline-translation/headings.ts`) — section titles
(`OUTLINE_SECTIONS`) from the `OutlineHeadingCatalog` (`outlineHeadingsTranslations.yml`),
configured anamnesis categories from the `AnamnesisCatalog`. A title missing for the language is
translated in one LLM call and persisted (`source: generated`), so every later plan shows the same
heading; the YAML is the ground truth and overwrites a generated value on its next sync
(`translationStore.ts`). Only the body crosses the sandwich (`translatePlanOut` skips the
localized headings); with the sandwich off the body is already in the request language, so only
the headings are swapped. Either way a handed-back plan's headings go back to English by position
(`restoreSkeletonHeadings`). LLM-named (freeform) category headings are case content: translated
with the body under the sandwich, written in the request language without it.

**Gateways:** each slice keeps its prompt building, LLM calls, retries and structured-output parsing in a `gateway.ts` (or `<concern>.gateway.ts` when a slice has several concerns, e.g. `04-case/02-procedures/{results,match}.gateway.ts`, `01-presentation/patient.gateway.ts`). Graph nodes are thin and call the gateway functions directly — the old `Tool<TInput, TOutput>` wrapper is gone (#189): its `inputSchema` was never enforced. Nodes are wrapped with `traceNode()` (`utils/nodeWrapper.ts`) to emit "Node Started/Completed" bus events with translated labels.

**Assembly** (`assemble.ts`'s `assembleCaseGraphs`) follows one rule, and the next person to
touch it will get it backwards: **compile on what the deployer chose; branch on what the caller
asked for.** `TRANSLATION_SANDWICH` is deployment config and is
compiled away — an _absent flag means an absent node_, not a node that is skipped. With
`TRANSLATION_SANDWICH=false` the two translation phases and their two conditional edges do not
exist, and neither does the sandwich's middle layer (#159): `assembleCaseGraphs` returns
`outlineOut: undefined, reviewIn: undefined`, and plan mode generates and shows the outline
directly in the request language instead (see "Outline segments" above). `generationFlags`,
`difficulty` and `language` are per-request and stay runtime branches — which is why, with the
sandwich _on_, the two conditional edges remain (whether this deployment can translate is the
deployer's choice; whether this request needs to is the caller's). Whether a _particular_
plan-mode request enters the compiled-in middle layer is itself a runtime branch, made outside
the graph: `CaseGenerationService.translatesOutline(data)` (`sandwich && language !==
"English"`) decides per job, in the job's status machine, not as a conditional edge — there is
no seam inside either top-level graph where that decision belongs, since the middle layer is
invoked between them, never mounted in either. They are two **different** predicates, not one
reused twice (issue 12 §3):
`requestNeedsTranslationOut()` (after generation) reads only `getRequestContext()?.language` off
ALS — generation always runs in English under the sandwich, so the response is translated back
regardless of how the request arrived. `requestNeedsTranslationIn(state)` (before generation)
additionally requires `state.callerSuppliedFreeText`: an ICD-only request already resolves an
English name from the catalogue, so translating it "to English" anyway used to pollute the
translation store with identity entries (`German: { "Diabetes": "Diabetes" }`) — a real bug, not
a hypothetical one. `callerSuppliedFreeText` is true when the request supplied a diagnosis
**name** (rather than only an `icd`) or any `userInstructions`; only `CaseGenerationService`
knows this; it computes the flag before ICD→name resolution and passes it into `planCase`'s
options object. Unlike `language`, `callerSuppliedFreeText` **is** a `CaseStateSchema` field —
it is per-request routing input the caller supplied, not a property of the bound ports (see the
Language section below for that distinction). The conditional edge on the `procedures`
generation flag stays a conditional edge in every variant, for the same "deployer compiles,
caller branches" reason.

`buildCaseGraph` compiles **both** flag values eagerly at boot into a map keyed by
`graphVariantKey` — each value now the `{ plan, case, outlineOut, reviewIn }` bundle
`assembleCaseGraphs` returns — and binds `planCase`/`renderCase`/`translateOutline`
to the one the config selects. Only one is ever served; the other proves every variant
compiles at boot rather than at config-change time, and gives `exportGraphs.ts` and the tests a
single source of assembly truth rather than a parallel code path that can drift. Compilation is
pure wiring with no I/O, so two is cheap.

`pnpm graph:export` writes **two** variants to `docs/graphs/`, keyed by `graphVariantKey`. Each
variant gets one diagram per run mode (`plan-mode.<variant>`, `normal-mode.<variant>`): the
script lives in `scripts/`, not
`src/`, so it never lands in `dist/`. It mounts the compiled graphs in an export-only wrapper
that draws the job service's call sequence as edges — plan, then (plan mode) `outlineOut` →
`human_review` → `reviewIn`, then case. The wrapper level is stripped from node ids before
`drawMermaid`, because that function silently drops every subgraph that sits under a prefix
with no edges of its own.

**Generation flags** (`src/core/graph/shared/domain/GenerationFlags.ts`): `patient`, `chiefComplaint`, `anamnesis`, `procedures`. Requests also carry a **difficulty** (`shared/domain/Difficulty.ts`: `easy | medium | hard`, default `medium`).

### AI Gateway Layer

Gateways live in the slice that uses them (see "Directory layout" below); only `shared/translation/translate.ts` (`translateRecordKeyed`/`translateTermsKeyed`, used by translate-in, translate-out and outline translation) and `shared/prompt/` (`prompt.ts`, `retry.ts`) are shared. Each gateway builds prompts, calls `runtime.llm.structured({ role, temperature }, { system, user }, schema, context)` — or `runtime.llm.text(...)` for the one free-text call, the outline — and wraps calls with `retry()` (retry feeds the previous validation error back into the prompt, so it is prompt logic and stays in the gateway). The port (`src/core/graph/runtime.ts`) speaks only core types (#190); `src/adapters/ai/llm.ts`'s `chatModelLlmPort` owns everything LangChain: `withStructuredOutput`, the message classes, the abort signal and mapping an unreachable model to `ModelUnreachableError`. Tests build a port over a fake chat model with the same `chatModelLlmPort`.

**LLM roles** (the `call` argument of `LlmPort.structured`/`text`, `src/core/graph/runtime.ts`) model two independent dimensions per call: `role` (`generator` | `judge` | `translator` — each independently configurable, e.g. a small local model generating against a stronger judge) and `temperature` (a fixed policy class, not configuration: `deterministic` = 0.1, `balanced` = 0.4, `creative` = 0.7, read from `adapters/ai/llm.ts`). Every call site's role/temperature pairing is fixed by what it does, not by config. Judges (`02-outline/gateway.ts`, `matchDiagnosis` in `04-case/02-procedures/match.gateway.ts`) and translators (`01-translate-in/gateway.ts`, `shared/translation/translate.ts`, the from-English translation tools) are the two roles that diverge from `generator`, which is everything else, including `generateSymptomsOneShot` (clinical content generation, not translation).

The underlying adapter supports three providers: `ollama`, `google`, `openai` (the `openai` provider also serves OpenAI-compatible endpoints via `LLM_URL`). Provider/model come from env — a general `LLM_PROVIDER`/`LLM_MODEL` plus optional per-role `LLM_GENERATOR_*`/`LLM_JUDGE_*`/`LLM_TRANSLATOR_*` overrides, each field falling back individually to the general value — or from a per-request `llmConfig` passed via `RequestContext` (AsyncLocalStorage), which applies uniformly to all three roles. The `ALLOW_LLMS` feature flag enables per-request LLM selection from an allowlist (`ALLOWED_LLMS=ollama:llama3.1,google:gemini-2.0-flash`); when set, no global LLM (and no per-role default) is configured and requests must supply `llmConfig` (exposed via `GET /api/allowedLlms`). Temperature is never part of `llmConfig`'s effective behavior — it is always the call site's fixed class.

### Content Parts

`chiefComplaint`, `anamnesis[].answer` and each procedure leaf's `result` (`case.procedures` is a
`ProcedureTree` — see "Catalogue Layer" below and `shared/domain/ProcedureTree.ts` — whose leaves are
`ProcedureResultSchema`) are `ContentPart[]` (`src/core/graph/shared/domain/ContentPart.ts`), not plain
strings — the shape that lets a future non-LLM provider (e.g. an image model reached over MCP)
contribute to a field:

```ts
type ContentPart = {
  type: string; // MIME type
  value: Uint8Array; // the rendered artifact
  alt: string; // plain text: the part's full content, in the working language
};
```

**Additive parts, all rendered.** The array is an ordered list of parts that together
_compose_ one field value — **not** a list of alternative renditions to choose between. Order
is meaningful, and an empty array is never a valid field value (`.min(1)` on the schema): a
field that exists has at least one part, a field that does not exist is absent.

**`alt` and `value` have different authors and different readers (issue 21, #191).** `alt` is
the part's **complete content in the working language** (English with the sandwich on, the
request language without) — every fact the part states, written out in full, not a label —
and it is the **only** thing machines read: `altOf(parts)` (`ContentPart.ts`, the parts' `alt`s
joined) is the one path from content parts to a prompt, for every MIME, used by
`presentationOf` and the prior-procedure projection the blinded solver and bridge reason over.
`value` is the rendered artifact for humans and never reaches a prompt. **`alt` is authored by
the planner, never by a provider**, and that is a safety property rather than a stylistic one:
a provider that could author `alt` could inject facts into the solver's view. The planners'
prompts say so explicitly ("later diagnostic steps read ONLY alt"). There is no MIME-dispatched
text extraction any more (`textOf`/`textOfPart`/`TEXT_EXTRACTORS` are gone, #191): one rule
for every field, and the solver reads the working language even when the rendered bytes are in
the target language.

Prompt builders take `string`, never `ContentPart[]`; the `Presentation` type in
`04-case/02-procedures/prompt.ts` is a text projection built by `presentationOf`
(`04-case/02-procedures/graph.ts`), not the domain `Case` shape — bytes must never reach a prompt.
`shared/prompt/prompt.ts`'s `renderForPrompt(value: unknown)` still accepts anything; that `unknown`
is a known hole, not a guarantee.

**A `Send` payload must never carry `ContentPart` bytes (issue 21).** LangGraph round-trips a
`Send` payload through JSON, so a `Uint8Array` arrives at the target node as a plain
index-keyed object — `instanceof Uint8Array` is false and the wire codec, the
`MAX_CONTENT_PART_BYTES` ceiling and every non-text extractor then see garbage. Verified
directly against `@langchain/langgraph` 1.3.0: the same state reaches a `Send`-dispatched node
as `Object` and a plain-edge-dispatched node as `Uint8Array`. Both translation phases
therefore fan out with **plain edges**, which hand each node the same full channel state
without serialising it; `buildFieldGenerationSends` stays a legitimate `Send` precisely
because its per-target payload (`{ diagnosis, outline, userInstructions }`) is text only. Fix
this at the seam, never with a repair on read — a normaliser on the read side leaves the
part corrupt everywhere else while looking fixed.

**The LLM never emits bytes.** A planner emits render requests and a text provider emits
ordinary strings, both under `z.string()`-based schemas — the domain `CaseSchema` (with its
`ContentPart[]` fields) is never used as an LLM output schema. `shared/modality/pipeline.ts`'s
`renderPlan` is the **only** place a `ContentPart` is constructed.

**Wire encoding** lives in exactly one place, `src/api/contentWire.ts` (`encodeCase`/
`decodeCase`, `CaseWireSchema`) — a boundary concern, not a domain one. `value` serializes to a
JSON string: UTF-8 verbatim for `text/*`, base64 for everything else; `alt` is required on the
wire for `text/*` parts (derivable from `value`) and restored on decode. Both the REST
(`transports/rest/routes/cases.router.ts`) and NATS (`transports/nats/cases.handler.ts`)
transports encode through it before a case leaves the process — without this, `Uint8Array`
would JSON-stringify to `{"0":102,"1":101,…}`. A part beyond `MAX_CONTENT_PART_BYTES` fails
loudly, naming the field and size, instead of silently shipping an oversized document.

**The translate-out phase is per-part, not whole-case (issue 12).** It used to project the whole
case to one text shape, translate it in a single free-text LLM call, and let that response
overwrite `case` wholesale via the state's shallow-merge reducer — silently clobbering the
cache-backed, catalogue-correct `procedures[].name`/`anamnesis[].category` translations a
separate node had just produced, since "translate only the VALUES" doesn't distinguish a
category/name from any other value. Fixed by disjointness, not by reordering: `translate_defined`
(catalog dictionary lookup, per-key locked LLM fill on a miss) and `translate_rest` (one LLM call
over a flat, keyed map of every `ContentPart.alt` in the case — built by
`05-translate-out/gateway.ts`'s `caseTextMap`, keyed by stable **path** rather than
by name, so translating a procedure's name can never collide with translating its result) run in
parallel and write to their own state channels, never to `case`. The map carries **one key per
part**, `chiefComplaint.0.alt`: renderers already write `value` in the target language (#192),
so translate-out translates only `alt` (the exposed, screen-reader text) and every part's
`value` passes through byte-identical, whatever its MIME. `translate_merge` is the only node
that applies both maps to `case`. Because only text reaches this prompt, and it is joined into a small keyed JSON object
rather than the whole case (patient object, procedure names, enums and all), the rest pass's
payload stays small — see issue 12's PR for a representative measurement. This is also
what unblocks issue 13: per-part translation survives a multi-part field, where the old
whole-case text projection would have collapsed it.

**`translate_defined`'s procedure half is node-keyed, not name-keyed (procedure tree, #PR2).**
It collects `nodeKey(path)` for every node — category and leaf — in `case.procedures`
(`nodePaths(tree).map(nodeKey)`), looks each up via `ProceduresRepo.getProcedureTranslation`, and
sends only the misses to `generateProceduresFromEnglish` (`translateRecordKeyed` under the hood:
keys are node keys, whose JSON path gives the model context; values are the node's own English
segment name — only the value is translated). Results land in
`definedTranslations.procedureNodes: Record<nodeKey, translatedName>`. `translate_rest`'s
`caseTextMap` walks `leaves(case.procedures)` and keys each leaf's result parts by
`procedures.<order>.result.<i>.{alt,text}` — `order`, not a DFS index, since the tree regroups by
category but a leaf's workup position must stay the stable key. `translate_merge` rebuilds
`case.procedures` in one `mapTree` pass — `category: (path, name) => procedureNodes[nodeKey(path)]
?? name`, `leaf: (path, leaf) => ({ ...leaf, name: procedureNodes[nodeKey([...path, leaf.name])]
?? leaf.name, result: <translated parts by order> })` — so category renaming, leaf renaming and
result translation all happen in the same walk.

### Modality Planning and Rendering

**Central planning, decoupled rendering (issue 21).** Each content-bearing field is planned by
one LLM call that reads the outline and decides _what each part should contain and which
provider renders it_; providers then render, in parallel, knowing only their own typed input.
The planner never imports a provider, a provider never sees the outline, and the per-field
registry is the only place they meet — at assembly time.

```ts
interface ModalityProvider<I = unknown> {
  readonly id: string; // discriminant in the planner's grammar
  readonly mime: string; // fixed per provider; the registry owns it, never the plan
  readonly description: string; // shown to the planner
  readonly inputSchema: z.ZodType<I>; // {} (text) | { bodyPart, finding, … }
  render(
    batch: { input: I; alt: string }[],
    ctx: RenderContext
  ): Promise<Uint8Array<ArrayBuffer>[]>;
}
```

**Every provider gets `{ input, alt }` and chooses what to use (#192).** Text providers define
an empty `inputSchema` and render the part's `alt` in their field's voice — so `alt` is the one
source of facts for both the solver and the human reader, and cannot drift from the rendered
text. A future provider may define a rich typed input and ignore `alt` completely. A provider
may **read** `alt`, never author it.

**Batch in, batch out**, one buffer per input in input order — that is what lets a provider
choose its own splitting: the anamnesis text provider makes **one** LLM call for every category
it was handed, not one per category. `defineModalityProvider` erases the generic so
heterogeneous providers share one array and re-validates each batch against `inputSchema`, which
is what keeps the `unknown` sound. `RenderContext` is exactly `RequestContext`, not a
signal-only shape (the issue 14 lesson: a provider may need `llmConfig` under `ALLOW_LLMS`).
Still **no LLM assumption in the port** — an image provider reaching a diffusion model over MCP
satisfies the same interface as the text one.

**Registries are per field** (`ModalityRegistries`, `shared/modality/registry.ts`): chief complaint may
have a PDF transfer-slip provider anamnesis has no use for. Providers live next to the field
they serve — `04-case/01-presentation/{chief-complaint,anamnesis}/providers.ts` and
`04-case/02-procedures/providers.ts` — mirroring the `catalog/<domain>/` vertical-slice convention, and
each is a thin adapter: prompts and LLM calls stay in that slice's `gateway.ts`. They live in `AssemblyDeps`, not `GraphFlags`, for `medicalBasisRegistry`'s reason: fixed
per deployment, shared by both flag variants.

**The planner always runs**, so unlike the medical-basis registry there is no
absent-capability-⇒-absent-node rule here and **no registry-size topology variance at all**: a
field is `plan_content → render_parts` whether one provider is registered or five. An empty
per-field registry is a build-time `EmptyModalityRegistryError`, which — since every variant
compiles eagerly at boot — fails the process at startup, never on the first request. This costs
one LLM call per field per request more than the old single-generator shape; that is a
deliberate trade for one uniform shape, taken with the alternative (a single-provider shortcut)
on the table.

`buildCompositionSchema` (`shared/modality/composition.ts`) builds the planner's grammar from the
field's registry — a `discriminatedUnion` on `provider` so a request naming `"text"` cannot
carry an image provider's input shape. Building an LLM grammar from runtime configuration is
the house style here, not a novelty: see `ProcedureCandidates.grammar()` and
`makeLanguageSchema`. Its `unitKeys` is **optional, and omitting it differs from passing an
empty array**: a known unit set (chief complaint's single unit, procedure names, anamnesis
under a configured category catalogue) makes `plans` a strict object with one required property
per key — every unit exactly once, by construction; an array of `{ key }` with an enum key and a
length check still admitted a duplicated key, which silently cost another unit its plan. A
_freeform_ field — anamnesis where `catalogs.anamnesis.list()` returns `undefined` because the
deployer configured no categories — stays an array of `{ key, … }` with a plain `z.string()` key
and a `.min(1)` count, so the planner names its own units (not a `z.record`: OpenAI strict mode
rejects open-keyed objects). That is the freedom the pre-planner generator had, and it must stay: a default category
list here would bake opinionated clinical content into code, which is what the catalogue layer
exists to prevent. `plansByKey` reads either shape back as a keyed record; the optional `unitSchema`
argument lets a caller extend the per-unit shape (procedures add `relevance`).

`renderPlan` (`shared/modality/pipeline.ts`) is the **only** place a `ContentPart` is constructed. It
flattens every unit's requests, groups them **by provider across units** (so one call covers
every category, and later every image), runs the providers concurrently, and scatters results
back into **planned order, not completion order** — the same rule and reason as
the medical-basis registry-order concatenation, tested with staggered fake providers where the
first-planned request resolves last. A provider that throws is logged and its parts dropped; a
unit left with zero parts fails loudly rather than silently producing an empty field.

**The procedure phase plans in the loop and renders once at the end.** `procedures[].result` is
produced inside the blinded-solver loop, so it does not get the two-node shape — instead
`result_step` and `bridge` **plan** results into a `plannedProcedures` channel, the solver runs
entirely on those plans, and a terminal `render_results` node (reached from both the
diagnosis-match and the bridge exit) renders every procedure's parts in one grouped pass and is
the only node that writes `case.procedures`. Two properties this buys: the solver's context is
short findings rather than full result text, and **nothing is ever rendered for a case still
being solved** — which matters the moment a provider is an image model. It also keeps the
loop's per-batch LLM cost identical, since one planner call replaces one result-generation
call; the bridge costs one extra call, once per generation, because it reuses
`ProcedureCandidates`' pick-then-plan machinery rather than duplicating a bespoke schema.

**A procedure result's `alt` is the one place `alt` carries the diagnostic payload.** The
blinded solver reasons over it and nothing else — the bytes do not exist yet — so it must be a
self-contained statement of the finding ("Chest X-ray: consolidation of the left lower lobe with
air bronchograms"), never a bare label ("chest x-ray image"). No test catches a bad one; the
solver just stops being able to solve.

**An image-only registry is still safe by construction:** every part carries the planner's
`alt`, and machines read nothing else, so the blinded solver and bridge keep working even when
no provider produces text.

**Rendering writes the target language directly (#192), so bytes are never translated.**
Renderers take `requestLanguage()` (the request's target language, sandwich or not) while
planners write `alt` in the working language, so an image with burnt-in annotations, speech, or
any rendering where meaning lives in the bytes comes out right without a post-render
translation. That resolves issue 13 §6. The render prompt is mixed-language with the sandwich
on (English `alt`, target-language output) — accepted. Planning and rendering stay distinct
nodes in every field; do not collapse them.

### Repo Layer (embedded SQLite via Drizzle)

The data layer lives entirely under `src/adapters/` (#188), organized as vertical slices rather
than one `repo/` directory. Shared SQLite infrastructure lives in `adapters/persistence/`; each
catalogue domain's repo lives inside its own slice under `adapters/catalog/<domain>/repo.ts`;
the symptoms cache is its own slice, `adapters/symptoms/`; and `adapters/repos.ts` composes
all of them into one `Repos` bundle. All of it backs lookups/caches with an embedded SQLite
DB at `data/cache/aetiomed.db` (`node:sqlite`, WAL; Drizzle ORM, migrations in `drizzle/`,
config in `drizzle.config.ts`).

**Every repo module exports a `createXxx(...)` factory and performs no I/O on import** —
`src/adapters/repos.test.ts` enforces that by importing `persistence/db.ts`, every
`catalog/<domain>/repo.ts`, `symptoms/repo.ts` and `repos.ts` itself and asserting neither
`fs.mkdirSync` nor a catalogue-file `fs.readFileSync` fired. `createRepos()` in `repos.ts`
constructs them once, from `createApp()`.

`src/adapters/persistence/`:

- `db.ts` — `createDb(cacheDir)` opens the DB and runs migrations; `syncSource()` re-ingests a YAML file only when its sha256 changed (fingerprints in `_meta`, keyed on the domain name so moving `CATALOG_DIR` does not invalidate the cache)
- `schema.ts` — tables: `_meta`, `translation`, `diagnosis`, `predefined_item`, `symptom_cache`
- `translationStore.ts` — cache-aside translation store used by diagnosis, procedures, anamnesis categories and trace labels. In-flight work is deduped **per key**; retries live inside the shared promise; runtime fills insert-if-absent and read back (first-writer-wins), while a YAML sync overwrites. `source` marks a row `curated` or `generated`; generated values persist in the DB, never back into YAML
- `paths.ts` — `resolveCatalogDir`/`resolveCacheDir` (`CATALOG_DIR`/`CACHE_DIR` resolution) and `catalogFile()`
- `predefinedList.ts` — reads a translations YAML file directly (bypassing `syncSource`'s hash cache) for startup validation

`src/adapters/catalog/<domain>/repo.ts` (`diagnosis/`, `procedures/`, `anamnesis/`,
`labels/`) — each syncs its YAML source(s) and exposes lookups. **Catalogue lists are
language-independent**; only the translation accessors take a language.

`src/adapters/symptoms/repo.ts` — static UMLS floor (behind `SymptomsRepo`, `02-plan/01-basis/ports.ts`) from `diagnosis_symptoms.json` + LLM-symptom cache with TTL (`SYMPTOM_CACHE_TTL_DAYS`)

There is no job repo (#159): the generator is stateless between calls, so nothing about a job
is ever written to the embedded database — see "Composition Root" above.

### Directory layout

`src/core/graph/` is cut by **position in the graph**, not by layer (#189): one directory per
compiled (sub)graph, nested like the mount tree, holding that subgraph's builder (`graph.ts`),
state, gateway(s), providers and tests. Directories are **numbered by execution order**, so a
file viewer shows the pipeline top to bottom; siblings that run in parallel
(`chief-complaint/`, `anamnesis/`) or inside one loop (`02-procedures/solver/`) carry no number,
because there is no order to encode.

```
01-translate-in/          translate_in_phase
02-plan/                  plan_phase
  01-basis/               basis_resolve: medical-basis registry and its providers
  02-outline/             outline_phase
03-outline-translation/   outlineOut / reviewIn (plan mode, between plan and case)
04-case/                  case_phase
  01-presentation/        presentation_phase (+ patient.gateway.ts)
    chief-complaint/  anamnesis/   chief_complaint_phase, anamnesis_phase
  02-procedures/          procedures_phase (+ results/match gateways)
    solver/               blinded child graph, drill-down strategy
05-translate-out/         translate_out_phase
shared/                   only what 2+ slices import
  domain/  modality/  outline/  prompt/  translation/  caseGenerationState.ts
```

A mounted subgraph's node id is its directory name without the number, kebab → snake, plus
`_phase` (`04-case/` ↔ `case_phase`, `chief-complaint/` ↔ `chief_complaint_phase`, #192); the
suffix is not decoration — LangGraph rejects a node named like a state channel, and `case` is
one. Plain function nodes keep verb names (`basis_resolve`, `patient_generate`). A slice never imports a
sibling top-level slice — `importBoundary.test.ts` enforces it; anything two slices need moves to
`shared/`. A model imported by one slice lives in that slice (`01-basis/symptom.ts`,
`02-outline/outlineEvaluation.ts`), not in `shared/domain/`. Outside the slices: `assemble.ts`
(both top-level graphs), `index.ts` (`initGraph`), `structure.ts`, `runtime.ts`, `config.ts`,
`catalog/` (ports only), `utils/`, `errors/`.

### REST Layer

`src/transports/rest/` (requires the `REST` feature flag). `createRestApp(opts)` builds the
Express app without listening — split out from `startRestServer(opts)` (= `createRestApp` +
listen) so tests can drive the real route table directly. Routes translate protocol only —
generation goes through `CaseGenerationService`, and every read-only route answers through the
shared `ReadModel` (`src/core/readModel.ts`, #144 — see "Shared read model" under NATS Layer
below), never by reaching into `GraphAppContext` directly:

- `GET /api/health` (not part of the read model — a liveness probe, not a domain read)
- `GET /api/features`, `GET /api/allowedLlms` — inline handlers calling
  `readModel.features()`/`readModel.allowedLlms()`
- `routes/cases.router.ts` — `POST /api/cases` (content negotiation — see below) and
  `DELETE /api/cases/:jobId` (cancel, through the `JobDirectory` — see below)
- `routes/diagnosis.router.ts` — `GET /api/diagnosis`, calling `readModel.diagnoses()`
- `routes/procedures.router.ts` — `GET /api/procedures`, calling `readModel.procedures()`
- `routes/labels.router.ts` — `GET /api/cases/:jobId/labels` (SSE, `event: label`, through the
  `JobDirectory` — see below) and `routes/graph.router.ts` — `GET /api/graph`, calling
  `readModel.graph()` (which wraps `core/graph/structure.ts`), both always mounted (#140) —
  labels are a product feature of the streaming API, not telemetry

**Both routes above go through the `JobDirectory` port (#145), not the channel or the service
directly** — `RestAppOptions.directory` is a required option, supplied by `app.ts`'s
`selectJobDirectory` (see "Composition Root" above), so this module never imports the NATS
transport itself. `GET /api/cases/:jobId/labels`: `directory.watch()` rejecting (the backbone
timed out) is a `504 UPSTREAM_TIMEOUT`; `{state: "unknown"}` is a `404 NOT_FOUND` — answered
**before any SSE stream opens**, which is the #145 behaviour change from the pre-#145 shape
(an unknown job used to open an SSE stream and immediately end it with `event: complete`,
making "wrong replica" indistinguishable from "job finished"); `{state: "terminal", complete}`
opens SSE just long enough to write `event: complete` and end; `{state: "active"}` opens SSE,
writes `event: connected`, then relays `listen()`'s events (`event: label`…, `event: complete`),
detaching via the returned `stop` on `req.on("close")`. `DELETE /api/cases/:jobId`:
`directory.cancel()` rejecting is a `504`; `"cancelled"` is `204`; `"finished"` and `"unknown"`
are both `404` (`NOT_FOUND`, with the message distinguishing "already finished" from "no active
generation" — a client that wants to tell those apart reads the message, not the status code).

**`POST /api/cases` is REST's synchronous transport, opened as a stream (#143), and answers one
_call_ — a plan-mode call without a plan stops at its plan, everything else runs to a case or an
error, all in this one request.** Content negotiation, not a second endpoint per mode: `Accept:
application/json` (or no preference) blocks and returns the outcome — the case (`200`), a
plan-mode plan (`200`, `{jobId, mode, language, plan}`), or the error; `Accept:
text/event-stream` opens SSE on the response — `event: accepted {jobId}` written **before any
node runs**, then `event: label`…, `event: plan` as soon as a plan exists (#159 — a normal-mode
call's plan on the way to its case, or a plan-mode call's terminal event), then
`event: result {case…}` / `event: error {error}` — except a plan-mode stream, which ends with
`event: plan`. Opening the stream with the request itself removes the handshake race a
202-then-subscribe design has: every event between minting the jobId and the client subscribing
would otherwise be lost, short of a replay buffer (deferred). A `: ping` comment is written every
`HEARTBEAT_MS` (15s; `heartbeatMs` in `RestAppOptions` overrides it for tests) independently of
label activity — a single node (outline generation on a local model, one solver iteration) can
stay silent for minutes, long enough for a proxy to treat the connection as idle; liveness and
telemetry are two concerns that happen to coincide, not one mechanism. `jobId` is a **body
field**, validated against `src/api/JobId.ts`'s `JobIdSchema` since it is also a NATS subject
token (`cases.result.<jobId>`) even when the request arrives over REST — the `?jobId=` query
param is gone. **A body with a `plan` generates the case from it**, skipping planning entirely;
the same jobId as the plan's own call is fine (#159) — the per-job channel allows exactly this
one reuse after a `planned` outcome (see `core/jobEvents/channel.ts`'s `open()` above). A
duplicate jobId otherwise (still running, or finished within the channel's tombstone window) is
a 409 `JOB_ALREADY_ACTIVE`/`JOB_ALREADY_COMPLETED` on either Accept path, answered before any
stream opens and without starting a second generation — `CaseGenerationService.start()` (see
"Case Generation Pipeline" above) is what makes the duplicate check synchronous with respect to
the caller. On either path, a client disconnect cancels the job (`res.on("close")` calling
`service.cancel(jobId)`) — there is no in-between-segments state to hold a paused job in any
more, so a disconnect always has a running call to cancel.

### NATS Layer

`src/transports/nats/` (requires the `NATS` feature flag). Split on **durability**, not on
feature — a JetStream stream's retention applies to everything its subject filter captures
(#142, which records the defects this fixed: a single
`cases.>` workqueue stream used to swallow results and cancels with no consumer, and results on
workqueue retention were single-delivery and stealable — the first ack destroyed them for every
other consumer).

Three JetStream streams (`src/transports/nats/subjects.ts`, `streams.ts`):

- **`CASE_REQUESTS`** (workqueue) — subjects `cases.request.*`. A submitted job
  (`cases.request.generate`) is taken by exactly one worker via the durable pull consumer
  `case-request-worker` (`REQUEST_CONSUMER`).
- **`CASE_RESULTS`** (limits, `max_age` ~1h) — subjects `cases.result.*`. A job's result is
  published on its own subject, `cases.result.<jobId>` (`resultSubject`), so any number of
  independent consumers can each read it, with replay — this is what makes "NATS provides the
  persistence" actually true; workqueue's first ack would have destroyed it for everyone else.
- **`CASE_PLANS`** (limits, `max_age` ~1h, #159) — subjects `cases.plan.*`. A job's plan is
  published on its own subject, `cases.plan.<jobId>` (`planSubject`), the same "durable per-job
  subject" shape as `resultSubject` and for the same reason — published in both modes: a
  plan-mode call ends with it, a normal-mode call hands it over on the way to its result. `msgID`
  is keyed on the job alone (`plan-<jobId>`): a job has at most one plan.
- **`cases.cancel.<jobId>`** (`cancelSubject`) — core NATS request/reply, not JetStream. Answered
  only by the replica that owns the job: `jobResponders.ts`'s `startJobResponders` subscribes to a
  job's cancel subject when the per-job event channel reports it `accepted` and unsubscribes on
  `complete`, so ownership is expressed as subscription interest rather than a lookup. An unknown
  or already-finished job therefore has **no responders at all** — the requester gets NATS's own
  "no responders" error immediately, never a wrong `{cancelled: false}` from a replica that
  merely doesn't own that job. `{cancelled: false}` only happens when the job finishes in the
  window between the request and the abort.
- **`cases.status.<jobId>`** (`statusSubject`, #145) — core NATS request/reply, the counterpart
  `createNatsJobDirectory`'s `watch()` requests after subscribing to the job's progress subjects.
  Same ownership-by-subscription-interest rule as `cancel` above, but the subscription **outlives
  the job**: `jobResponders.ts` keeps answering `{state: "terminal", complete}` for
  `TOMBSTONE_MS` after the job's `complete` (mirroring the channel's own tombstone,
  `core/jobEvents/channel.ts`), then stops — at which point "no responders" starts meaning
  "unknown" again rather than "ask again in a second". This is exactly what lets a remote
  observer's `JobDirectory.watch()` tell "finished" (`{state: "terminal"}`) from "never existed
  here" (`{state: "unknown"}`) across replicas, the same distinction `channel.peek()` makes
  in-process. A `planned` job stops answering at once (#159), same as `cancel` above: its
  continuation, with the same jobId, may run on any replica, so this one must not answer for it
  once it is over.
- `cases.progress.<jobId>.<accepted|label|complete>` (core NATS, ephemeral fan-out, #144) — see
  "Progress publisher" below.

`streams.ts`'s `ensureStreams(jsm)` creates or reconciles all three streams and the durable
consumer at startup. It fails loudly, not silently, in the two cases JetStream cannot fix in
place: the **pre-#142 `cases` stream still exists** (its `cases.>` filter overlaps every stream
here, and retention cannot be changed on an existing stream) — the error message names the
stream and tells the operator to run `nats stream rm cases`, and existing deployments must do
this manually before upgrading; or a stream exists with a different retention policy than
configured.

`cases.handler.ts`'s `runRequestWorker` pulls one request at a time, and **only once a
generation slot is free** — `service.reserveSlot()` is awaited before the next
`consumer.next()`, so a message this replica cannot start yet stays in the stream for another
replica rather than being pulled and queued in memory. While a generation runs,
`consumeCaseGenerateMessage` calls `msg.working()` every `WORKING_INTERVAL_MS` to keep the ack
deadline (`REQUEST_ACK_WAIT_MS`, short) from expiring mid-generation — a crashed replica's job is
still redelivered quickly, but a merely slow one isn't punished for it.

**Ack only once the call's output is published (#159).** The generator keeps nothing between
calls, so an unacked request _is_ the recovery path: a replica that dies mid-call stops
heartbeating (`msg.working()`), the short ack wait (`REQUEST_ACK_WAIT_MS`) runs out, and
JetStream hands the request to another replica — which reruns it from the start, or, for a
plan-mode continuation carrying its `plan`, reruns only the second half. `consumeCaseGenerateMessage`
(`cases.handler.ts`) calls `service.generate()`, publishes its outcome with `publishStop`, and
only then calls `msg.ack()` — there is no earlier ack point, since there is no checkpoint to be
durable at. The consumer's `max_deliver` is `REQUEST_MAX_ATTEMPTS + 1` (`streams.ts`): every
delivery up to `REQUEST_MAX_ATTEMPTS` is a plain retry, and the one past it is caught by
`msg.info.deliveryCount > REQUEST_MAX_ATTEMPTS` in the handler, which publishes
`RETRIES_EXHAUSTED` to `cases.result.<jobId>` instead of trying again. `publishStop(graph,
result)` (`cases.publisher.ts`) is the one function every caller of a call's result goes
through — the request worker and REST's equivalent path — so "what a stop publishes" is decided
once: `planned` goes to `cases.plan.<jobId>`, `done`/`failed` go to `cases.result.<jobId>`. A
duplicate delivery whose jobId is already running or finished on this replica
(`JOB_ALREADY_ACTIVE`/`JOB_ALREADY_COMPLETED`) is logged and acked without publishing anything —
answering it would overwrite the real job's own result.

**NATS parity (#144).** The stated requirement is
that a client speaking only NATS, or only REST, has every **feature** — asymmetry is allowed only
in delivery guarantees:

| REST                               | NATS                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| SSE `event: label` on a job        | `cases.progress.<jobId>.<accepted\|label\|complete>` |
| `GET /api/diagnosis`               | `catalog.diagnosis`                                  |
| `GET /api/procedures`              | `catalog.procedures`                                 |
| `GET /api/features`                | `meta.features`                                      |
| `GET /api/allowedLlms`             | `meta.allowedLlms`                                   |
| `GET /api/graph`                   | `meta.graph`                                         |
| `event: plan` (stop or on the way) | `cases.plan.<jobId>` (#159)                          |

- **Progress publisher** (`progressPublisher.ts`'s `startProgressPublisher`) is a second adapter
  onto the core-owned per-job channel (`src/core/jobEvents/`) — the first being the REST SSE
  writer. It forwards **every** event (`accepted`, `label`, `complete`) onto
  `cases.progress.<jobId>.<type>` — the subject's last token is the event type, exactly like the
  SSE `event:` name, so there is no mapping table. Deliberately **core NATS, never JetStream**:
  labels are high-frequency and worthless after the job ends, so a stream write per node event
  would be pure overhead for data with a useful life of milliseconds, and publishing to a subject
  with no subscriber is essentially free on core NATS — so there is no subscriber check. An
  invalid jobId (fails `JobIdSchema`, same guard as `jobResponders.ts`) is skipped with a
  once-per-job warning; a publish failure (e.g. a closing connection) is caught and logged — a
  side channel must never break generation.
- **Request/reply meta service** (`metaService.ts`'s `startMetaService`) answers the five
  catalogue/feature/graph reads above using **`@nats-io/services`**, the NATS "micro" framework
  (`Svcm`/`Service`/`ServiceMsg`). Chosen over five bare `nc.subscribe` request/reply handlers
  because it gives a NATS-only client discovery (`$SRV.PING|INFO|STATS.aetiomed`), per-endpoint
  stats, and a standard error mechanism (`msg.respondError(500, message)`) for free — close to the
  literal definition of "a NATS-only client has every feature" — at the cost of one small
  dependency from the same `@nats-io/*` org already in `package.json`. The service is named
  `aetiomed`, versioned from the repo's own `package.json` (`version` field, read at runtime
  relative to `import.meta.url`, three directories below the repo root in both `src/` and
  `dist/`, and copied into the `Dockerfile`'s `runner` stage for this; falls back to `"0.0.0"`
  if unreadable). Every endpoint replies `JSON.stringify(value ?? null)`
  on success; the framework's default queue group is used (every replica answers reads
  identically). Subject constants live in `subjects.ts` alongside the others
  (`CATALOG_DIAGNOSIS_SUBJECT`, `CATALOG_PROCEDURES_SUBJECT`, `META_FEATURES_SUBJECT`,
  `META_ALLOWED_LLMS_SUBJECT`, `META_GRAPH_SUBJECT`).
- **Job directory** (`jobDirectory.ts`'s `createNatsJobDirectory(nc)`, #145) is the NATS-side
  half of the `JobDirectory` port (see "Composition Root" above for the port itself):
  `watch(jobId)` subscribes to `progressWildcard(jobId)` (`cases.progress.<jobId>.>`) **before**
  requesting `cases.status.<jobId>`, so a job that completes between the two still delivers its
  `complete` into the already-open subscription rather than racing past it; `cancel(jobId)`
  requests `cases.cancel.<jobId>`. Both map NATS's "no responders" to `{state: "unknown"}` /
  `"unknown"` and a request timeout (`DIRECTORY_REQUEST_TIMEOUT_MS`) to a rejected promise — the
  distinction REST's routers turn into 404 vs. 504.
- **Shared read model** (`src/core/readModel.ts`'s `createReadModel(graph, features)`) is what
  makes "the NATS endpoint returns the same payload as its REST counterpart" true **by
  construction**: one object with `diagnoses()`, `procedures()`, `features()`, `allowedLlms()`
  and `graph()`, constructed once in `app.ts` and handed to both `startRestServer` (as
  `createRestApp`'s `readModel` option) and `startNatsTransport`. REST's routers and the meta
  service both call the same five functions rather than each reimplementing the read against
  `GraphAppContext`.

### Data Files

`CATALOG_DIR` (default `data/`) contains the files synced into the SQLite cache at startup
(only re-parsed when changed). Paths below are relative to it:

- `procedures.yml` / `proceduresTranslations.yml` — approved procedure catalogue, a tree of
  categories (any depth) and procedures (when set, LLM must select from this tree only, placed
  under its exact category); translations mirror the same tree, each node keyed by its English
  `key` alongside its translated `name`
- `diagnosis.yml` / `diagnosisTranslations.yml` — ICD-11 diagnosis lookup
- `anamnesisCategories.yml` / `anamnesisCategoriesTranslations.yml` — anamnesis section definitions (static config, no longer a request field)
- `labelTranslations.yml` — trace-node label translations
- `outlineHeadingsTranslations.yml` — plan-mode outline section-title translations (keys:
  `OUTLINE_SECTIONS`); missing titles are LLM-translated once and cached in the DB
- `diagnosis_symptoms.json` — UMLS-derived symptom floor per ICD code (loaded directly, not via the DB sync)
  The embedded SQLite DB is generated under `CACHE_DIR` (default `data/cache/`), which is
  deliberately a separate directory so a deployer can mount their own catalogues over
  `CATALOG_DIR` without clobbering it.

`scripts/extract-icd11*.ts` build the diagnosis YAML files from ICD-11 source data (run manually).

### Request Context

`runWithContext(fn, jobId?, llmConfig?, language?, signal?)` in `src/core/graph/utils/context.ts`
uses `AsyncLocalStorage` to propagate `jobId`, optional `llmConfig`, optional `language` and an
abort `signal` through the entire async call chain. Graph nodes read it via
`getRequestContext()` — `RequestContextSchema` also doubles as LangGraph's own runtime-context
schema at every `new StateGraph(state, RequestContextSchema)` call site, but `language` is never
read from _that_ copy (see Language below); only `getRequestContext()` (ALS) is the real read
path.

Cancellation is owned entirely by `CaseGenerationService`, not by `runWithContext` itself
(`src/core/graph/utils/cancelManager.ts` is deleted, #142). `CaseGenerationService.generate`
registers one `AbortController` per job **at submission**, before the job's generation slot is
even acquired — so a job still queued behind `MAX_CONCURRENT_GENERATIONS` is cancellable too, not
just a running one — and passes its `signal` into `runWithContext`. `service.cancel(jobId)` aborts
that controller directly; there is no separate registry a transport reaches into.

`runWithContext` no longer registers a job hook of any kind (#139) — that was the old
single-slot `registerJobHook()`, deleted along with the now-removed `src/tracing/` module
entirely (#140). It only binds ALS now. The per-job channel's lifetime is owned by
`CaseGenerationService` instead: it calls `jobEvents.open(jobId)` before `runWithContext`, and
`jobEvents.close(jobId, outcome)` once the run settles, so every transport sees the same per-job
lifecycle regardless of which door the request came in through. Core still does not import
`observability/` or `transports/`: `NodeTracer`/`NodeSpan` (`utils/nodeWrapper.ts`, issue #141)
is the same port/adapter inversion applied to OTel — core owns the port, `observability/otel.ts`
implements it, `app.ts` wires the two together.

**Concurrency is one limiter shared by both transports (#142).** `src/core/concurrency.ts`'s
`createLimiter(max)` is a FIFO counting semaphore: `acquire(signal?)` resolves an idempotent
`Release` once a slot is free, and rejects with an `AbortError` (without ever taking a slot) if
`signal` aborts while queued — the same primitive used for both the queued-cancel case above and
the not-yet-acquired case below. `CaseGenerationService` is constructed with one such limiter
sized to `MAX_CONCURRENT_GENERATIONS` (default 4); `generate(req, { slot? })`'s `opts.slot` lets
a caller hand in a slot it already holds instead of acquiring its own — the NATS worker calls
`service.reserveSlot()` and only then pulls a message off `CASE_REQUESTS`, so a request nothing
can run yet is never even dequeued into memory, while REST's `POST /api/cases` just lets
`generate` acquire its own slot inline. Either way the service releases the slot exactly once
when the job ends, including when a slot handed in turns out to address a duplicate `jobId` (a 409) that never runs.

`CaseGenerationService` calls `limiter.acquire(signal)` only — there is no priority distinction
between a fresh call and a plan-mode continuation carrying its `plan`; both queue FIFO like any
other request (#159 removed the priority lanes an earlier, checkpointed design needed to let a
resumed job jump the queue — there is nothing left to resume).

### Language

Language is a property of the **bound ports**, not of graph state and not of LangGraph's own
runtime context (subgraph _state_ is filtered by the child's schema; subgraph _context_ is
not, so a narrower context schema would not actually stop a leak — removing the field would).
Concretely:

- **`LANGUAGES`** (env, `config.ts`) is the deployer-declared supported set — comma-separated,
  trimmed, de-duplicated, order preserved, defaulting to `English,German`. `English` is
  mandatory (startup fails otherwise): it is the pivot language the translation sandwich turns
  on and the base catalogue's identity space. `shared/domain/Language.ts`'s `Language`/
  `ForeignLanguage` are plain `string` aliases (not a literal-union enum) precisely because the
  supported set is runtime configuration — `makeLanguageSchema(languages)` builds the real
  validator from it. `makeCaseGenerationRequestSchema(config)` validates a request's `language`
  against `config.LANGUAGES`, so an unsupported language is a **400** from the API boundary,
  never a 500 from deep in the graph. `validateCatalogsOrExit` (extended, not duplicated, from
  its existing per-language summary) exits non-zero naming any catalogue that has zero
  translation entries for a configured non-English language, and warns (does not fail) for a
  translated language that is declared in a YAML file but not in `LANGUAGES`.
- **ALS, not state — except `callerSuppliedFreeText`, which is state, not ALS (issue 12 §3).**
  `runWithContext` stores the request's `language` on the same `AsyncLocalStorage`-carried
  `RequestContext` that already carries `llmConfig` and the abort `signal`. `CaseStateSchema`
  (`assemble.ts`) has no `language` field; the translate-out conditional edge calls
  `requestNeedsTranslationOut()`, which reads `getRequestContext()?.language`. The translation
  subgraphs (`01-translate-in/`, `05-translate-out/`) likewise have
  no `language` state field and read it off ALS inside their node functions. `language` stays on
  ALS because it is a property of the _bound ports_ — the same value for every node in a request,
  decided before the graph ever runs. `callerSuppliedFreeText` is different: it is per-request
  **routing input the caller supplied** (did they send a diagnosis name or userInstructions, as
  opposed to only an `icd`?), so it lives on `CaseStateSchema` and the translate-**in** edge
  (`requestNeedsTranslationIn(state)`) reads it from state, not ALS — "branch on what the caller
  asked for" (the assembly rule above) applies to routing inputs, not only to deployer flags.
  Known limitation, carried over from `llmConfig`: ALS-carried values are invisible to
  checkpoints, so anything resumable (F09) must rebuild `language` from the original request
  rather than expect it to survive a resume.
- **Explicit language per call (#190).** A gateway that writes user-visible text (chief
  complaint and anamnesis planners/renderers, procedure-result planner/renderer, the
  outline in plan mode) takes a `language` parameter and builds its system prompt with
  `buildSystemPrompt(language, ...sections)` (`shared/prompt/prompt.ts`), which appends the
  language directive as the system message's final line (never the user message, so it stays
  inside the stable prefix and doesn't disturb prompt caching) when `language` is set and not
  English. Internal reasoning calls (the plan in normal mode, the plan judge, the blinded solver,
  `matchDiagnosis`, the symptom/basis provider, and the patient — `Patient` holds no free text, only numbers, an enum and a name, #191) use plain `buildPrompt` and take no language —
  English in both sandwich modes, which keeps the generation core language-agnostic. The caller
  decides: nodes and providers pass `boundLanguage(runtime)` (`runtime.languageOverride ?? ALS
language`), so the choice is visible at every call site instead of hidden in the prompt builder.
  Translator utilities (`01-translate-in/gateway.ts`, `shared/translation/translate.ts`) state
  their target language in the prompt itself and use `buildPrompt`.
- **Sandwich-on forces English at the port, not per call.** With `TRANSLATION_SANDWICH` on,
  generation must run entirely in English regardless of the request's real target language —
  `assembleCaseGraph` builds the generation phase from a runtime with
  `languageOverride: "English"` (`GraphRuntime.languageOverride`, `runtime.ts`), which
  `boundLanguage` prefers over the ambient ALS language. That is a compile-time binding (one per
  compiled variant), not a per-request branch. It binds the internal calls and the planners
  (so `alt` is English); renderers are exempt by design and always write the target language
  (`requestLanguage()`, see "Modality Planning and Rendering").
- **Non-sandwich mode's known gap.** With the sandwich off, free-text fields (chief complaint,
  anamnesis answers, procedure result text) are generated natively in the
  target language via the directive above. **Controlled vocabulary stays English**:
  `procedures[].name` and `anamnesis[].category` are literal-union grammar picks from the
  English catalogue (issue 01's Rule 4 deletion made catalogue reads language-independent), so
  there is no translate-out step to localize them and they come back English. This is a known,
  documented gap, not an oversight — localizing them is a catalogue dictionary lookup, exactly
  what `translate_defined` already does in the sandwich-on `05-translate-out/`
  (issue 12); building a second copy of that machinery for non-sandwich mode would just
  duplicate it. Localized candidate grammars for non-sandwich mode
  (picking directly from a target-language catalogue) are tracked separately —
  #123 — because they reverse issue 01's Rule 4
  deletion and deserve their own decision.
- **Auto-detection is a laddered resolver in `CaseGenerationService`, not the graph**
  (`src/core/languageDetection/`, issue 10). A caller may omit `language`; the service resolves
  it once, before `runWithContext` binds anything, via:

  ```
  1. language explicitly provided       → use it                      (no cost)
  2. deterministic n-gram detector      → use it if above threshold   (no cost, offline)
  3. LLM fallback, only if enabled      → one cheap call              (rare, opt-in)
  4. otherwise                          → configured default (English)
  ```

  This lives in the communication/service layer because its output _selects the ports_
  generation binds, and binding happens before invoke — a detection node inside the graph could
  not inform the thing its answer is for. It is also request normalisation, so it sits beside
  the ICD→name resolution the service already does; it is **not** a graph flag and never adds a
  compiled variant. `LANGUAGE_AUTO_DETECT` gates steps 2–3 together; step 3 needs its own further
  opt-in, `LANGUAGE_DETECT_LLM_FALLBACK`, so a deployer never pays LLM calls unknowingly just for
  turning on auto-detect.

  Detection runs on `userInstructions` only, **never the diagnosis name** — two decisive
  reasons: an ICD-only request's diagnosis name is resolved from our own English catalogue, so
  detecting on it would be circular; and diagnosis names are 2-3 words and frequently Latin
  (_"Diabetes mellitus"_ is byte-identical in English, German and Spanish). `UserInstructions` is
  a per-field record of strings, concatenated into one blob for detection; text under ~30
  characters is too short for n-gram detection and skips straight to step 4.

  The detector is `tinyld` (`src/adapters/language/tinyldDetector.ts`, passed in by `createApp()`), wrapped behind a
  `LanguageDetector` port (`languageDetection/port.ts`) so it is fakeable in tests and swappable
  later — offline, TypeScript-native, and `detectAll()` returns an explicit
  `{ lang, accuracy }[]` distribution (`accuracy` reads directly as this port's confidence)
  rather than `franc`'s relative distances. ISO 639-1 codes are mapped to this deployment's
  configured language **names** in exactly one place, `languageDetection/mapping.ts`; a
  configured language the table does not know simply never wins step 2 — it stays fully usable
  passed explicitly at step 1 — and `validateCatalogsOrExit` (the same reporter as the
  `LANGUAGES` validation above, not a second one) warns about it by name at startup without
  failing. The resolved language is echoed back as `language` in
  `CaseGenerationResponseSchema`'s success branch and the NATS success payload (and on
  `CaseGenerationResult`), so a client can notice a wrong auto-detect guess and retry explicitly.

## Environment Variables

| Variable                                                              | Default                 | Notes                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                                | `3030`                  | Server port                                                                                                                                                                                      |
| `FEATURES`                                                            | `""`                    | Comma-separated flags: `REST`, `NATS`, `DEBUG`, `ALLOW_LLMS`                                                                                                                                     |
| `LLM_PROVIDER`                                                        | —                       | `ollama` \| `google` \| `openai` (required unless `ALLOW_LLMS`)                                                                                                                                  |
| `LLM_MODEL`                                                           | —                       | Model name (required unless `ALLOW_LLMS`)                                                                                                                                                        |
| `LLM_API_KEY`                                                         | —                       | API key for Google/OpenAI                                                                                                                                                                        |
| `LLM_URL`                                                             | —                       | Override base URL (e.g. local Ollama or OpenAI-compatible endpoints)                                                                                                                             |
| `LLM_GENERATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`             | —                       | Optional per-field override for the `generator` role; unset fields fall back to the general `LLM_*` value                                                                                        |
| `LLM_JUDGE_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`                 | —                       | Optional per-field override for the `judge` role (same per-field fallback)                                                                                                                       |
| `LLM_TRANSLATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`            | —                       | Optional per-field override for the `translator` role (same per-field fallback)                                                                                                                  |
| `TRANSLATION_SANDWICH`                                                | `true`                  | `false`/`0` compiles the translation phases out of the graph entirely                                                                                                                            |
| `LANGUAGES`                                                           | `English,German`        | Comma-separated deployment language set, trimmed/de-duplicated/order-preserved; must include `English`. Validated at startup and against every request's `language` (see Language section below) |
| `LANGUAGE_AUTO_DETECT`                                                | `false`                 | `true`/`1` enables steps 2–3 of the language-detection ladder for a request that omits `language` (see Language section below); not a graph flag                                                 |
| `LANGUAGE_DETECT_LLM_FALLBACK`                                        | `false`                 | `true`/`1` additionally enables step 3 (one LLM call) when the offline detector is below threshold; ignored unless `LANGUAGE_AUTO_DETECT` is also set                                            |
| `ALLOWED_LLMS`                                                        | —                       | Format: `ollama:model1,google:model2` (requires `ALLOW_LLMS` flag)                                                                                                                               |
| `CATALOG_DIR`                                                         | `data`                  | Deployer-owned, read-only catalogue inputs (YAML/JSON config files); resolved absolute against `process.cwd()` when relative                                                                     |
| `CACHE_DIR`                                                           | `data/cache`            | Generated, writable output — the embedded SQLite database (`aetiomed.db`) lives here; resolved absolute against `process.cwd()` when relative                                                    |
| `NATS_URL`                                                            | `nats://localhost:4222` | `nats://nats:4222` in docker compose                                                                                                                                                             |
| `NATS_USER` / `NATS_PASSWORD`                                         | `nats` / `nats`         |                                                                                                                                                                                                  |
| `MAX_CONCURRENT_GENERATIONS`                                          | `4`                     | Bounds in-flight generations identically over REST and NATS (`src/core/concurrency.ts`'s shared limiter). Excess requests queue; a queued job is still cancellable. See Request Context below    |
| `SYMPTOM_CACHE_TTL_DAYS`                                              | `30`                    | TTL for cached LLM-generated symptoms (see `adapters/symptoms/repo.ts`)                                                                                                                          |
| `MAX_CONTENT_PART_BYTES`                                              | `5000000`               | Ceiling on one `ContentPart.value`'s decoded byte size; encoding a larger part fails loudly (see `api/contentWire.ts`)                                                                           |
| `OTEL_SDK_DISABLED`                                                   | unset (enabled)         | Standard OTel var. `"true"` (that literal only) skips constructing the OTel SDK entirely (no dynamic import even happens — see `observability/otel.ts`); its own axis, independent of `FEATURES` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `_TRACES_ENDPOINT` / `_LOGS_ENDPOINT` | —                       | Standard OTel vars, read by the OTLP trace/log exporters themselves — no plumbing in this repo; any one set selects the `"otlp"` exporter mode (`selectExporterMode`)                            |
| `OTEL_SERVICE_NAME`                                                   | —                       | Standard OTel var, read via `envDetector` (`observability/otel.ts`)                                                                                                                              |

Note: the `REST` flag is required for the HTTP API to load — include it in `FEATURES` when running the server.

## Path Aliases

`@/*` → `src/*` (configured in `tsconfig.json`; resolved at runtime by `tsx`, at build time by `tsc-alias`).
