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

It also owns shutdown (issue 18): `createApp()` returns `{ bus, shutdown }`, where `shutdown()`
closes everything it started in the **reverse** of construction order — REST, then NATS, then
the DB last — bounded by a 5-second deadline (`src/shutdown.ts`'s `installSignalHandlers`,
wired up by `src/index.ts`). No module under `src/core/graph/` or `src/transports/` registers
a process signal handler any more; each returns a closer instead.

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

It also owns **generation-flag normalisation**
(`models/GenerationFlags.ts`: `expandFlagsForSolver` / `projectCaseToFlags`). A
`generationFlags: ["procedures"]` request cannot be served literally — the blinded solver
reasons from the patient presentation, and would otherwise be handed an empty one after the
plan and its judge loop had already been paid for. So the three presentation fields are
generated **internally** and projected back out of the response, and the caller gets exactly
the fields they asked for. The cheaper-looking alternative — reusing the plan outline as the
solver's presentation — is unsafe: `state.outline` is free-text markdown that by construction
contains a "Workup / Procedure Results Strategy" section, so slicing a presentation out of it
by heading is a parse whose failure mode is silently leaking that strategy into the _blinded_
solver. See `expandFlagsForSolver`'s doc comment.

**`src/core/jobEvents/`** (#139) is the core-owned per-job event channel:
`createJobEventChannel()` builds one instance, constructed once in `app.ts` and handed to
`CaseGenerationService` (which `open()`s it before its first await and `close()`s it with the
job's outcome on every path) and to every transport, which only ever `subscribe()`s. Event
names double as the SSE `event:` name on REST and the last subject token on NATS
(`cases.progress.<jobId>.<name>`), so no adapter needs a name-mapping table. `wireLabels`
(`core/jobEvents/labels.ts`) also lives in core now, not in `tracing/` — it turns the graph's
node lifecycle bus events into localized `label` events, using the `language` now carried
directly on the bus event (set by `traceNode` from ALS) rather than a per-job language map.

**Modules under `src/transports/` and `src/observability/`** are ordinary modules with a start
function, not plugins: `transports/rest/` (`createRestApp`/`startRestServer` — see the REST
Layer section below for its always-on routes), `transports/nats/` (`startNatsTransport`), and
`observability/` (`otel.ts`, `tracePayload.ts` — the OTel operator channel; see below). `src/api/`
holds the shared request/response Zod schemas.

The typed **`EventBus`** (`src/core/event-bus.ts`) is kept — it genuinely decouples the label
and OTel channels from the graph. Modules augment its `EventMap` interface via TypeScript
module augmentation.

**Labels and OTel spans (#139/#140/#141) are two channels, not one — the axis of the split is
payload, not event count** (`docs/issues/17-transport-parity.md` §D7 and §"Concerns with D7").
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
  itself (issue #141, `docs/issues/17-transport-parity.md` §"OpenTelemetry"). OTLP-exported
  only, never SSE/NATS. Gated by the standard
  `OTEL_SDK_DISABLED`/`OTEL_EXPORTER_OTLP_ENDPOINT`(`_TRACES_ENDPOINT`/`_LOGS_ENDPOINT`)/`OTEL_SERVICE_NAME`
  — its own axis, independent of any `FEATURES` flag except `DEBUG`, which only picks the
  exporter (below), never gates the channel itself. `src/observability/otel.ts` is the one
  place `@opentelemetry/*` is imported and these env vars are read; core only knows the
  `NodeTracer`/`NodeSpan` port (`core/graph/utils/nodeWrapper.ts`) — the same
  port-owned-by-core/adapter-lives-outside inversion `core/jobEvents/` uses for labels.
- **OTel logs — the node's output** (issue #141). `NodeSpan.setOutput(output)` hands the
  adapter the node's already-sanitized result (bytes projected to text — `sanitizeForTrace`,
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
  attribute may ever carry output text — `ContentPart[]` fields are always projected through
  `textOf` first, so raw bytes never reach either signal.
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
`generation_phase:presentation_phase:chief_complaint_generate:plan_content`), not the bare
name passed to `traceNode` — two different subgraphs reuse bare names like `plan_content` and
`render_parts`, so `TraceNodeFn.scope()` (`nodeWrapper.ts`) threads the same qualification
LangGraph computes at every point a compiled subgraph is mounted (issue 15 §3/§4, still true).

**`GET /api/graph`** (`core/graph/structure.ts` + `transports/rest/routes/graph.router.ts`) is
always on, following labels' gate: it returns the deployment's actually-compiled topology —
nodes (with English `labelKey`) and edges from `getGraphAsync({ xray: true })`, the same call
`02graphs/exportGraphs.ts` uses for mermaid diagrams. Label keys, not localized strings: the
structure is language-independent and cacheable; a client wanting localization already has it
on the label channel, per job.

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

All AI generation uses LangGraph. Graphs live in `src/core/graph/02graphs/`. The top-level
graph is assembled from the deployer's flags by `assembleCaseGraph(deps, flags)`
(`caseGraph.ts`) and sequences up to three subgraphs:

1. **`01case-translation-to-english/`** — translates `diagnosis.name` and, alongside it, every
   `userInstructions` value, to English. Two disjoint-channel `Send` nodes
   (`translate_diagnosis`/`translate_user_instructions`) run in parallel from `START`, each
   writing only its own top-level field — no merge is needed.
2. **`02case-generation/`** — the core generation pipeline (see below)
3. **`03case-translation-from-english/`** — three nodes, not a chain (issue 12): `translate_defined`
   and `translate_rest` run in parallel from `START`, each writing only its own state channel
   (`definedTranslations`/`restTranslations`, never `case`); `translate_merge` is the **only**
   node that writes `case`, applying both maps to it. See "Content Parts" below for why this
   replaced a whole-case, single-LLM-call translator.

`generateCase(opts)` invokes the top-level graph, taking one options object —
`{ diagnosis, generationFlags, userInstructions?, language?, difficulty?, callerSuppliedFreeText }`
(`GenerateCaseFn`, `appContext.ts`) — rather than positional scalars, since a sixth parameter
(`callerSuppliedFreeText`, issue 12 §3) would have made the positional form unreadable at the
call site. `language` is **not** threaded into graph state or LangGraph's own runtime context —
by the time this runs, `runWithContext` (called by `CaseGenerationService`) has already bound it
on `AsyncLocalStorage`, which is what the translation-routing edges and every generation gateway
actually read. `callerSuppliedFreeText` **is** threaded into graph state (`CaseStateSchema`) —
see the Language section below for why the two differ.

The **`caseGenerationGraph`** (`02case-generation/index.ts`) runs up to three phases — the first is compiled in only when the medical-basis registry is non-empty:

- **`basis_resolve`** — runs first, and only when the medical-basis registry (`src/core/graph/medicalBasis/`) is non-empty: an absent registry means an absent node, not a node that runs and does nothing. The registry is a plain list built once in the composition root (`graph/index.ts`'s `createMedicalBasisRegistry`), **not** a third compile-time flag — its _size_ decides whether `basis_resolve` is compiled in, the same rule `caseGraph.ts` applies to `TRANSLATION_SANDWICH`/`PROCEDURE_PRESELECTION`. Every registered `MedicalBasisProvider` (`medicalBasis/ports.ts`) is run concurrently and their `BasisFragment`s are concatenated in **registry order** (not completion order) — there is no LLM call spent deciding which source to use; a throwing provider is logged and skipped, a hanging one is bounded by the request's abort signal. `medicalBasis/render.ts` renders the concatenated fragments into one "Medical basis" section of the plan's **user** message only (never the system message), each fragment fenced and tagged with its `sourceId`/`label`/`retrievedAt`(/`licence`) — the fence delimiters are escaped if they appear inside a fragment's own content, so a fragment can never close its own fence early. `medicalBasis/providers/umlsSymptoms.ts` is the only provider today: it reproduces the former `01symptom/` node verbatim — a static UMLS symptom floor (per ICD code) unioned with cache-aside LLM-generated additions (skips the LLM on a fresh cache hit) — as a single "Typical symptoms" fragment.
- **`02presentation/`** — `generation/` generates a detailed case outline (the complete factual record of the case), then a combined outline evaluate ⇄ revise `Command` loop (max 2 iterations) judging obviousness AND clinical consistency in one LLM call; once accepted, fans out via `Send` to `patient_generate` / `chief_complaint_generate` / `anamnesis_generate` (gated per `generationFlags`), joining at `case_fan_in`. There is no post-fan-out consistency check. `chief_complaint_generate` and `anamnesis_generate` are **compiled subgraphs** (`chiefComplaint/index.ts`, `anamnesis/index.ts`), not function nodes — see "Modality Planning and Rendering" below for their internal `plan_content → render_parts` shape. `patient_generate` stays a plain function node: `patient` is not a `ContentPart[]` field (it stayed a structured `Patient` object through issue 11), so there is nothing for a modality provider to render — the `Send` payload (`{ diagnosis, outline, userInstructions }`) is identical across all three targets either way, whether the target is a function or a compiled subgraph.
- **Subgraph output schemas (issue 17).** A compiled subgraph mounted with `addNode` writes back its **entire state schema** by default, not just the channels its nodes actually touched. `chief_complaint_generate` and `anamnesis_generate` are `Send`-fanned out in parallel from `outline_evaluate` above, so both writing back the whole state made their shared `diagnosis`/`userInstructions`/`outline` `LastValue` channels each receive two values in one superstep — `INVALID_CONCURRENT_GRAPH_UPDATE` on every default request. The rule: **a compiled subgraph's state schema is its input surface; its `output` schema is its write surface, and the write surface must be declared explicitly** — every `addNode`'d or `.invoke()`d subgraph in `02graphs/` gets an `output` built with `.pick()` off that graph's own state schema (never a hand-written duplicate, so the picked channel keeps the identical reducer registration). `chiefComplaintGraph`/`anamnesisGraph` output `{ case }`; `presentation_phase` (`buildFieldGenerationGraph`) deliberately outputs `{ case, outline }` — `outline` is not obvious to drop, but `03procedure/`'s `result_step` needs it for `generateProcedureResults`; `procedure_phase`/`generation_phase`/`translation_from_english_phase` output `{ case }`; `translation_to_english_phase` outputs `{ diagnosis, userInstructions }`, since translating those two is its entire job; the blinded solver's child graph (`.invoke()`d, not mounted) outputs `{ move }`. `case_fan_in` used to be `passthrough` (echoing the whole incoming state as its "update"); a join point produces no update, so it is now a node returning `{}`.
- **`03procedure/`** — only when the `procedures` flag is set. A **blinded solver** loop (max 6 iterations) with 4 nodes: `blinded_step` orders procedures without knowing the true diagnosis, `result_step` _plans_ their results non-blinded (issue 21 — nothing renders inside the loop; see "Modality Planning and Rendering" below), and the terminal `render_results` renders every procedure's parts in one grouped pass and is the only node that writes `case.procedures`; when the solver commits to a diagnosis, an LLM judge checks the match (loop continues with `ruledOutDiagnoses` on mismatch). On exhaustion, a `bridge` node generates confirmatory procedures for the true diagnosis. The approved procedure list is presented (and picked) grouped by category (`{ "Category": ["Name", …] }`, with uncategorized procedures under a synthetic `"General"` bucket) rather than as one flat list — this applies to both the blinded pick and the (non-blinded) bridge pick, the latter grouping full `{name, relevance, result}` objects per category. Procedure selection is a `ProcedureStrategy` port (`03procedure/strategy/`: `ports.ts`, `directPick.ts`, `categoryScopedPick.ts`, `index.ts`'s `createProcedureStrategy`) rather than a branch of a global config read inside the node — `blinded_step` and `bridge` call `strategy.nextStep()` / `strategy.bridge()` and never read `PROCEDURE_PRESELECTION` themselves; the strategy is selected once at graph-assembly time and threaded down as a constructed object. `DirectPick` is one LLM call against the full candidate list per step (the default). `CategoryScopedPick` — selected only when `PROCEDURE_PRESELECTION` is set **and** the approved list has real categories (a flat catalogue has nothing to scope on) — splits that single call into two sequential calls (a category-only pick, over-inclusive, followed by a procedure/results-only pick scoped to those categories plus `"General"`); the graph shape stays fixed at 4 nodes regardless of which strategy runs. The blinded scoped pick may answer with an `expand` action requesting additional categories: a bounded loop in `CategoryScopedPick.nextStep` unions them into a local scope set and retries (max 2 expansions per `blinded_step`; the expand grammar only admits categories not yet in scope, and past the cap the branch is removed from the schema entirely — the visited set lives in code, never the model). The bridge's scoped pick instead retries deterministically once with all categories if it returns empty. The blinded step's own compiled child graph (built once per strategy, invoked — not added as a node — from inside `blinded_step`) has a state schema that structurally omits `diagnosis`: the `BlindedView` type already makes passing it a compile error, and the child graph is a runtime backstop on top of that (LangGraph filters input against a graph's state schema before it reaches a channel). `matchDiagnosis` stays in the parent node, outside the blinded path, since it's an oracle call. Additional guards: already-ordered procedures are excluded from every candidate list/grammar (duplicate orders are impossible by construction), category-pick prompts show per-category counts plus sample names, and blinded prompts include the remaining iteration budget as convergence pressure.

**Tool pattern:** each subgraph directory has a `tools.ts` exporting `Tool<TInput, TOutput>` objects (`src/core/graph/utils/tool.ts`). Graph nodes are thin — prompt building, LLM calls, retries, and structured-output parsing live in the aigateway behind the tools. Nodes are wrapped with `traceNode()` (`utils/nodeWrapper.ts`) to emit "Node Started/Completed" bus events with translated labels.

**Assembly** (`caseGraph.ts`) follows one rule, and the next person to touch it will get it
backwards: **compile on what the deployer chose; branch on what the caller asked for.**
`TRANSLATION_SANDWICH` and `PROCEDURE_PRESELECTION` are deployment config and are compiled
away — an _absent flag means an absent node_, not a node that is skipped. With
`TRANSLATION_SANDWICH=false` the two translation phases and their two conditional edges do not
exist. `generationFlags`, `difficulty` and `language` are per-request and stay runtime
branches — which is why, with the sandwich _on_, the two conditional edges remain (whether this
deployment can translate is the deployer's choice; whether this request needs to is the
caller's). They are two **different** predicates, not one reused twice (issue 12 §3):
`requestNeedsTranslationOut()` (after generation) reads only `getRequestContext()?.language` off
ALS — generation always runs in English under the sandwich, so the response is translated back
regardless of how the request arrived. `requestNeedsTranslationIn(state)` (before generation)
additionally requires `state.callerSuppliedFreeText`: an ICD-only request already resolves an
English name from the catalogue, so translating it "to English" anyway used to pollute the
translation store with identity entries (`German: { "Diabetes": "Diabetes" }`) — a real bug, not
a hypothetical one. `callerSuppliedFreeText` is true when the request supplied a diagnosis
**name** (rather than only an `icd`) or any `userInstructions`; only `CaseGenerationService`
knows this; it computes the flag before ICD→name resolution and passes it into `generateCase`'s
options object. Unlike `language`, `callerSuppliedFreeText` **is** a `CaseStateSchema` field —
it is per-request routing input the caller supplied, not a property of the bound ports (see the
Language section below for that distinction). The conditional edge on the `procedures`
generation flag stays a conditional edge in every variant, for the same "deployer compiles,
caller branches" reason.

`buildCaseGraph` compiles **all four** flag combinations eagerly at boot into a map keyed by
`graphVariantKey`, and binds `generateCase` to the one the config selects. Only one is ever
served; the other three prove every variant compiles at boot rather than at config-change
time, and give `exportGraphs.ts` and the tests a single source of assembly truth rather than a
parallel code path that can drift. Compilation is pure wiring with no I/O, so four is cheap.

`pnpm graph:export` writes **two** topologies to `docs/graphs/`, not four:
`PROCEDURE_PRESELECTION` swaps a `ProcedureStrategy` adapter and leaves the procedure graph at
three nodes either way, so it is not a shape (`graphTopologyKey` is the authority, and
`caseGraph.test.ts` asserts the premise still holds). Each topology gets the one detailed view
the script produces.

**Generation flags** (`src/core/graph/models/GenerationFlags.ts`): `patient`, `chiefComplaint`, `anamnesis`, `procedures`. Requests also carry a **difficulty** (`models/Difficulty.ts`: `easy | medium | hard`, default `medium`).

### AI Gateway Layer

`src/core/graph/03aigateway/` contains one file per generated field (case, symptoms, patient, chiefComplaint, anamnesis, outlineEvaluation, procedures, diagnosis, labels, plus `translate.helper.ts`). Each gateway builds prompts, calls `runtime.llm.for({ role, temperature }, context?.llmConfig)` (from `src/core/graph/runtime.ts`, implemented in `src/core/graph/utils/llm.ts`), and wraps calls with `retry()`.

**LLM roles** (`LlmPort.for`, `src/core/graph/runtime.ts`) model two independent dimensions per call: `role` (`generator` | `judge` | `translator` — each independently configurable, e.g. a small local model generating against a stronger judge) and `temperature` (a fixed policy class, not configuration: `deterministic` = 0.1, `balanced` = 0.4, `creative` = 0.7, read from `utils/llm.ts`). Every call site's role/temperature pairing is fixed by what it does, not by config. Judges (`outlineEvaluation.aigateway.ts`, `matchDiagnosis` in `procedures.aigateway.ts`) and translators (`diagnosis.aigateway.ts`, `translate.helper.ts`, the from-English translation tools) are the two roles that diverge from `generator`, which is everything else, including `generateSymptomsOneShot` (clinical content generation, not translation).

The underlying adapter supports three providers: `ollama`, `google`, `openai` (the `openai` provider also serves OpenAI-compatible endpoints via `LLM_URL`). Provider/model come from env — a general `LLM_PROVIDER`/`LLM_MODEL` plus optional per-role `LLM_GENERATOR_*`/`LLM_JUDGE_*`/`LLM_TRANSLATOR_*` overrides, each field falling back individually to the general value — or from a per-request `llmConfig` passed via `RequestContext` (AsyncLocalStorage), which applies uniformly to all three roles. The `ALLOW_LLMS` feature flag enables per-request LLM selection from an allowlist (`ALLOWED_LLMS=ollama:llama3.1,google:gemini-2.0-flash`); when set, no global LLM (and no per-role default) is configured and requests must supply `llmConfig` (exposed via `GET /api/allowedLlms`). Temperature is never part of `llmConfig`'s effective behavior — it is always the call site's fixed class.

### Content Parts

`chiefComplaint`, `anamnesis[].answer` and `procedures[].result` are `ContentPart[]`
(`src/core/graph/models/ContentPart.ts`), not plain strings — the shape that lets a future
non-LLM provider (e.g. an image model reached over MCP) contribute to a field:

```ts
type ContentPart = {
  type: string; // MIME type
  value: Uint8Array; // the rendered artifact
  alt: string; // plain text: a short description of what this part conveys
};
```

**Additive parts, all rendered.** The array is an ordered list of parts that together
_compose_ one field value — **not** a list of alternative renditions to choose between. Order
is meaningful, and an empty array is never a valid field value (`.min(1)` on the schema): a
field that exists has at least one part, a field that does not exist is absent.

**`alt` and `value` are independent, with different authors (issue 21).** `value` is the
rendered artifact and `alt` is a short description of what it conveys; neither is derived from
the other, and `textPart()` — the old constructor that asserted `value === utf8(alt)` — is
gone, replaced by `encodeText()` for the `value` half alone. **`alt` is authored by the
planner, never by a provider**, and that is a safety property rather than a stylistic one:
`textOf()` feeds the blinded solver, `matchDiagnosis` and the plan judge, so a provider that
could author `alt` could inject facts into the solver's view.

**`textOf(parts)` is still the only path from content parts to a prompt, but it is now
MIME-dispatched.** `textOfPart` looks a part's `type` up in a `const` table in
`ContentPart.ts` — one row today, `text/*` → UTF-8 decode `value` — and falls back to `alt`
for anything with no row. For a text part the prose lives in `value`, so reading `alt` would
return the label instead of the content; for an image part the bytes mean nothing to a prompt,
so `alt` is the projection. Add a row (e.g. `application/pdf`) rather than a runtime
registration API: this repo deleted its extension system in #115 and a mutable global registry
of extractors would rebuild exactly that shape.

Prompt builders take `string`, never `ContentPart[]`; the `Presentation` type in
`03aigateway/procedures.aigateway.ts` is a text projection built by `presentationOf`
(`03procedure/index.ts`), not the domain `Case` shape — bytes must never reach a prompt.
`utils/prompt.ts`'s `renderForPrompt(value: unknown)` still accepts anything; that `unknown`
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
this at the seam, never with a repair on read — a normaliser inside `textOfPart` leaves the
part corrupt everywhere else while looking fixed.

**The LLM never emits bytes.** A planner emits render requests and a text provider emits
ordinary strings, both under `z.string()`-based schemas — the domain `CaseSchema` (with its
`ContentPart[]` fields) is never used as an LLM output schema. `modality/pipeline.ts`'s
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
`03case-translation-from-english/tools.ts`'s `caseTextMap`, keyed by stable **path** rather than
by name, so translating a procedure's name can never collide with translating its result) run in
parallel and write to their own state channels, never to `case`. Since issue 21 made `alt` and
`value` independent, the map carries **two keys per part**: `chiefComplaint.0.alt` for every
part, and `chiefComplaint.0.text` for `text/*` parts only — the decoded prose, which is now the
content rather than a duplicate of the label. `translate_merge` is the only node that applies
both maps to `case`: a text part takes the translated prose into `value` and the translated
label into `alt`; any other part's `value` passes through byte-identical, translating only
`alt`. Because only text reaches this prompt, and it is joined into a small keyed JSON object
rather than the whole case (patient object, procedure names, enums and all), the rest pass's
payload stays small — see issue 12's PR for a representative measurement. This is also
what unblocks issue 13: per-part translation survives a multi-part field, where the old
whole-case text projection would have collapsed it.

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
  readonly inputSchema: z.ZodType<I>; // { instruction } | { bodyPart, finding, … }
  render(batch: I[], ctx: RenderContext): Promise<Uint8Array<ArrayBuffer>[]>;
}
```

**Batch in, batch out**, one buffer per input in input order — that is what lets a provider
choose its own splitting: the anamnesis text provider makes **one** LLM call for every category
it was handed, not one per category. `defineModalityProvider` erases the generic so
heterogeneous providers share one array and re-validates each batch against `inputSchema`, which
is what keeps the `unknown` sound. `RenderContext` is exactly `RequestContext`, not a
signal-only shape (the issue 14 lesson: a provider may need `llmConfig` under `ALLOW_LLMS`).
Still **no LLM assumption in the port** — an image provider reaching a diffusion model over MCP
satisfies the same interface as the text one.

**Registries are per field** (`ModalityRegistries`, `modality/registry.ts`): chief complaint may
have a PDF transfer-slip provider anamnesis has no use for. Providers live next to the field
they serve — `02presentation/generation/{chiefComplaint,anamnesis}/providers.ts` and
`03procedure/providers.ts` — mirroring the `catalog/<domain>/` vertical-slice convention, and
each is a thin adapter: prompts and LLM calls stay in `03aigateway/`, per the numbered-layer
rule. They live in `AssemblyDeps`, not `GraphFlags`, for `medicalBasisRegistry`'s reason: fixed
per deployment, shared by all four flag variants.

**The planner always runs**, so unlike the medical-basis registry there is no
absent-capability-⇒-absent-node rule here and **no registry-size topology variance at all**: a
field is `plan_content → render_parts` whether one provider is registered or five. An empty
per-field registry is a build-time `EmptyModalityRegistryError`, which — since every variant
compiles eagerly at boot — fails the process at startup, never on the first request. This costs
one LLM call per field per request more than the old single-generator shape; that is a
deliberate trade for one uniform shape, taken with the alternative (a single-provider shortcut)
on the table.

`buildCompositionSchema` (`modality/composition.ts`) builds the planner's grammar from the
field's registry — a `discriminatedUnion` on `provider` so a request naming `"text"` cannot
carry an image provider's input shape. Building an LLM grammar from runtime configuration is
the house style here, not a novelty: see `ProcedureCandidates.grammar()` and
`makeLanguageSchema`. Its `unitKeys` is **optional, and omitting it differs from passing an
empty array**: a known unit set (chief complaint's single unit, anamnesis under a configured
category catalogue) pins both key names and plan count, while a _freeform_ field — anamnesis
where `catalogs.anamnesis.list()` returns `undefined` because the deployer configured no
categories — gets a plain `z.string()` key and a `.min(1)` count, so the planner names its own
units. That is the freedom the pre-planner generator had, and it must stay: a default category
list here would bake opinionated clinical content into code, which is what the catalogue layer
exists to prevent.

`renderPlan` (`modality/pipeline.ts`) is the **only** place a `ContentPart` is constructed. It
flattens every unit's requests, groups them **by provider across units** (so one call covers
every category, and later every image), runs the providers concurrently, and scatters results
back into **planned order, not completion order** — the same rule and reason as
`medicalBasis`'s registry-order concatenation, tested with staggered fake providers where the
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
`alt`, and `textOfPart` falls back to `alt` for any non-text MIME, so the plan judge,
`matchDiagnosis` and the blinded solver keep working even when no provider produces text.

**Known limitation, recorded rather than fixed (issue 13 §6):** rendering runs before
translate-out, so with the sandwich on a modality is rendered from an **English** instruction
and its bytes are never translated — only `alt` and, for text parts, the decoded prose are
(issue 12, extended in issue 21 §8). Fine for plain text; not fine for a future image with
burnt-in annotations, speech, or any rendering where meaning lives in the bytes. The migration
path stays open only because planning and rendering are distinct nodes in every field — moving
rendering to a post-translation phase is then a _move_, not a rewrite. Do not collapse them.

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

`02case-generation/`'s former `01symptom/` node is gone the same way `03repo/` is: replaced by
`medicalBasis/`, deliberately unnumbered rather than renumbered, because it is not one pipeline
step any more — it is a registry of zero or more providers (see the Case Generation Pipeline
section above), and a number would no longer mean anything.

Plus unnumbered `catalog/`, `persistence/`, `symptoms/`, `medicalBasis/`, `modality/`, `repos.ts`,
`models/` (Zod domain models), `utils/`, `errors/`, `config.ts`.

### REST Layer

`src/transports/rest/` (requires the `REST` feature flag). `createRestApp(opts)` builds the
Express app without listening — split out from `startRestServer(opts)` (= `createRestApp` +
listen) so tests can drive the real route table directly. Routes translate protocol only —
generation goes through `CaseGenerationService`:

- `GET /api/health`, `GET /api/features`, `GET /api/allowedLlms`
- `routes/cases.router.ts` — `POST /api/cases` (aborts on client disconnect), `DELETE /api/cases/:jobId` (cancel)
- `routes/diagnosis.router.ts` — `GET /api/diagnosis`
- `routes/procedures.router.ts` — `GET /api/procedures`
- `routes/labels.router.ts` — `GET /api/cases/:jobId/labels` (SSE, `event: label`, adapting
  `core/jobEvents/`) and `routes/graph.router.ts` — `GET /api/graph` (compiled topology,
  `core/graph/structure.ts`), both always mounted (#140) — labels are a product feature of the
  streaming API, not telemetry

`POST /api/cases` accepts a jobId two ways — `?jobId=` (query) or `jobId` in the body — validated
against `src/api/JobId.ts`'s `JobIdSchema` either way, since it is also a NATS subject token
(`cases.result.<jobId>`) even when the request arrives over REST: `.`, `*`, `>` and whitespace
would silently address a different subject, so a jobId containing any of those is a 400, not a
500 raised deep in a NATS-only code path.

### NATS Layer

`src/transports/nats/` (requires the `NATS` feature flag). Split on **durability**, not on
feature — a JetStream stream's retention applies to everything its subject filter captures
(#142; see `docs/issues/17-transport-parity.md` §D6 for the defects this fixed: a single
`cases.>` workqueue stream used to swallow results and cancels with no consumer, and results on
workqueue retention were single-delivery and stealable — the first ack destroyed them for every
other consumer).

Four channels, two JetStream streams (`src/transports/nats/subjects.ts`, `streams.ts`):

- **`CASE_REQUESTS`** (workqueue) — subjects `cases.request.*`. A submitted job
  (`cases.request.generate`) is taken by exactly one worker via the durable pull consumer
  `case-request-worker` (`REQUEST_CONSUMER`).
- **`CASE_RESULTS`** (limits, `max_age` ~1h) — subjects `cases.result.*`. A job's result is
  published on its own subject, `cases.result.<jobId>` (`resultSubject`), so any number of
  independent consumers can each read it, with replay — this is what makes "NATS provides the
  persistence" actually true; workqueue's first ack would have destroyed it for everyone else.
- **`cases.cancel.<jobId>`** (`cancelSubject`) — core NATS request/reply, not JetStream. Answered
  only by the replica that owns the job: `jobResponders.ts`'s `startJobResponders` subscribes to a
  job's cancel subject when the per-job event channel reports it `accepted` and unsubscribes on
  `complete`, so ownership is expressed as subscription interest rather than a lookup. An unknown
  or already-finished job therefore has **no responders at all** — the requester gets NATS's own
  "no responders" error immediately, never a wrong `{cancelled: false}` from a replica that
  merely doesn't own that job. `{cancelled: false}` only happens when the job finishes in the
  window between the request and the abort.
- `cases.progress.<jobId>.<label|trace>` (core NATS, ephemeral fan-out) is reserved for #144.

`streams.ts`'s `ensureStreams(jsm)` creates or reconciles both streams and the durable consumer
at startup. It fails loudly, not silently, in the two cases JetStream cannot fix in place: the
**pre-#142 `cases` stream still exists** (its `cases.>` filter overlaps both new streams, and
retention cannot be changed on an existing stream) — the error message names the stream and
tells the operator to run `nats stream rm cases`, and existing deployments must do this manually
before upgrading; or a stream exists with a different retention policy than configured.

`cases.handler.ts`'s `runRequestWorker` pulls one request at a time, and **only once a
generation slot is free** — `service.reserveSlot()` is awaited before the next
`consumer.next()`, so a message this replica cannot start yet stays in the stream for another
replica rather than being pulled and queued in memory. While a generation runs,
`consumeCaseGenerateMessage` calls `msg.working()` every `WORKING_INTERVAL_MS` to keep the ack
deadline (`REQUEST_ACK_WAIT_MS`, short) from expiring mid-generation — a crashed replica's job is
still redelivered quickly, but a merely slow one isn't punished for it.

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

### Language

Language is a property of the **bound ports**, not of graph state and not of LangGraph's own
runtime context (subgraph _state_ is filtered by the child's schema; subgraph _context_ is
not, so a narrower context schema would not actually stop a leak — removing the field would).
Concretely:

- **`LANGUAGES`** (env, `config.ts`) is the deployer-declared supported set — comma-separated,
  trimmed, de-duplicated, order preserved, defaulting to `English,German`. `English` is
  mandatory (startup fails otherwise): it is the pivot language the translation sandwich turns
  on and the base catalogue's identity space. `models/Language.ts`'s `Language`/
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
  (`caseGraph.ts`) has no `language` field; the translate-out conditional edge calls
  `requestNeedsTranslationOut()`, which reads `getRequestContext()?.language`. The translation
  subgraphs (`01case-translation-to-english/`, `03case-translation-from-english/`) likewise have
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
- **Audience split.** Every LLM call site is `audience: "internal"` (the plan, the plan judge,
  the blinded solver, `matchDiagnosis`, the symptom/basis provider — English in both sandwich
  modes, which is what keeps the generation core language-agnostic) or `"user-facing"` (chief
  complaint, anamnesis answers, patient, procedure result text). `buildSystemPrompt(runtime,
audience, ...sections)` (`utils/prompt.ts`, next to `buildPrompt`) is the one seam: for
  `"user-facing"` calls it appends the language directive as the system message's final line
  (never the user message, so it stays inside the stable prefix and doesn't disturb prompt
  caching) whenever a foreign language is bound — `internal` calls and English never get it.
  Every gateway in `03aigateway/` that generates case content uses this builder instead of
  `buildPrompt` for its system prompt; a file that still calls `buildPrompt` for its system
  prompt is either a translator utility with an explicit, already-stated target language
  (`diagnosis.aigateway.ts`, `translate.helper.ts` — deliberately out of the conversion, see
  their comments) or has forgotten to convert.
- **Sandwich-on forces English at the port, not per call.** With `TRANSLATION_SANDWICH` on,
  generation must run entirely in English regardless of the request's real target language —
  `assembleCaseGraph` builds the generation phase from a runtime with
  `languageOverride: "English"` (`GraphRuntime.languageOverride`, `runtime.ts`), which
  `buildSystemPrompt` prefers over the ambient ALS language. That is a compile-time binding
  (one per compiled variant), not a per-request branch, and it is why `buildSystemPrompt` never
  needs to know the sandwich exists: "a foreign language is bound" already means "sandwich off
  and non-English" by the time any gateway call reaches it.
- **Non-sandwich mode's known gap.** With the sandwich off, free-text fields (chief complaint,
  anamnesis answers, procedure result text, patient narrative) are generated natively in the
  target language via the directive above. **Controlled vocabulary stays English**:
  `procedures[].name` and `anamnesis[].category` are literal-union grammar picks from the
  English catalogue (issue 01's Rule 4 deletion made catalogue reads language-independent), so
  there is no translate-out step to localize them and they come back English. This is a known,
  documented gap, not an oversight — localizing them is a catalogue dictionary lookup, exactly
  what `translate_defined` already does in the sandwich-on `03case-translation-from-english/`
  (issue 12); building a second copy of that machinery for non-sandwich mode would just
  duplicate it. Localized candidate grammars for non-sandwich mode
  (picking directly from a target-language catalogue) are tracked separately —
  `docs/issues/16-localized-candidate-grammars.md` — because they reverse issue 01's Rule 4
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

  The detector is `tinyld` (`languageDetection/tinyldDetector.ts`), wrapped behind a
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
| `PROCEDURE_PRESELECTION`                                              | `false`                 | `true`/`1` selects the `CategoryScopedPick` procedure strategy (splits the blinded procedure step into a category pick then a procedure pick)                                                    |
| `LANGUAGES`                                                           | `English,German`        | Comma-separated deployment language set, trimmed/de-duplicated/order-preserved; must include `English`. Validated at startup and against every request's `language` (see Language section below) |
| `LANGUAGE_AUTO_DETECT`                                                | `false`                 | `true`/`1` enables steps 2–3 of the language-detection ladder for a request that omits `language` (see Language section below); not a graph flag                                                 |
| `LANGUAGE_DETECT_LLM_FALLBACK`                                        | `false`                 | `true`/`1` additionally enables step 3 (one LLM call) when the offline detector is below threshold; ignored unless `LANGUAGE_AUTO_DETECT` is also set                                            |
| `ALLOWED_LLMS`                                                        | —                       | Format: `ollama:model1,google:model2` (requires `ALLOW_LLMS` flag)                                                                                                                               |
| `CATALOG_DIR`                                                         | `data`                  | Deployer-owned, read-only catalogue inputs (YAML/JSON config files); resolved absolute against `process.cwd()` when relative                                                                     |
| `CACHE_DIR`                                                           | `data/cache`            | Generated, writable output — the embedded SQLite database (`aetiomed.db`) lives here; resolved absolute against `process.cwd()` when relative                                                    |
| `NATS_URL`                                                            | `nats://localhost:4222` | `nats://nats:4222` in docker compose                                                                                                                                                             |
| `NATS_USER` / `NATS_PASSWORD`                                         | `nats` / `nats`         |                                                                                                                                                                                                  |
| `MAX_CONCURRENT_GENERATIONS`                                          | `4`                     | Bounds in-flight generations identically over REST and NATS (`src/core/concurrency.ts`'s shared limiter). Excess requests queue; a queued job is still cancellable. See Request Context below    |
| `SYMPTOM_CACHE_TTL_DAYS`                                              | `30`                    | TTL for cached LLM-generated symptoms (see `symptoms/repo.ts`)                                                                                                                                   |
| `MAX_CONTENT_PART_BYTES`                                              | `5000000`               | Ceiling on one `ContentPart.value`'s decoded byte size; encoding a larger part fails loudly (see `api/contentWire.ts`)                                                                           |
| `OTEL_SDK_DISABLED`                                                   | unset (enabled)         | Standard OTel var. `"true"` (that literal only) skips constructing the OTel SDK entirely (no dynamic import even happens — see `observability/otel.ts`); its own axis, independent of `FEATURES` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `_TRACES_ENDPOINT` / `_LOGS_ENDPOINT` | —                       | Standard OTel vars, read by the OTLP trace/log exporters themselves — no plumbing in this repo; any one set selects the `"otlp"` exporter mode (`selectExporterMode`)                            |
| `OTEL_SERVICE_NAME`                                                   | —                       | Standard OTel var, read via `envDetector` (`observability/otel.ts`)                                                                                                                              |

Note: the `REST` flag is required for the HTTP API to load — include it in `FEATURES` when running the server.

## Path Aliases

`@/*` → `src/*` (configured in `tsconfig.json`; resolved at runtime by `tsx`, at build time by `tsc-alias`).
