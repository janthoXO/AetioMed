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

**Modules under `src/transports/` and `src/tracing/`** are ordinary modules with a start
function, not plugins: `transports/rest/` (`startRestServer`), `transports/nats/`
(`startNatsTransport`), `tracing/` (`wireTracing`, which registers a job hook on the
core-owned registry in `utils/context.ts`) and `tracing/sse/` (SSE streaming, mounted onto
the Express app built by `transports/rest/` — it still depends on `rest/`, which is fine and
unchanged). `src/api/` holds the shared request/response Zod schemas.

The typed **`EventBus`** (`src/core/event-bus.ts`) is kept — it genuinely decouples tracing
from the graph. Modules augment its `EventMap` interface via TypeScript module
augmentation.

**Labels, traces and OTel (issue 15) are three channels, not one.** They differ in audience,
content, language and gate:

|          | Labels                                       | Traces (SSE)             | OTel spans                          |
| -------- | -------------------------------------------- | ------------------------ | ----------------------------------- |
| Audience | end user                                     | developer/operator, live | operator, cross-request analysis    |
| Content  | one short phrase per node                    | node output, size-capped | span attributes only, never payload |
| Language | localized at the transport, English fallback | English, always          | n/a (attribute values only)         |
| Gate     | `FEATURES=TRACING`                           | `FEATURES=TRACING`       | `OTEL_SDK_DISABLED` — its own axis  |

Labels and traces are separate SSE event types (`event: label` / `event: trace`) on the same
per-job stream, not one `type`-discriminated payload — see `tracing/index.ts`'s `wireTracing`
and `tracing/sse/router.ts`. A `TraceEvent` (`tracing/traceManager.ts`) carries the node's
**LangGraph node id** (`nodeId`, matching `GET /api/graph` below) and English `labelKey`;
`payload: any` is gone. A node's output is capped at `MAX_TRACE_PAYLOAD_BYTES`
(`tracing/tracePayload.ts`) — over the cap it becomes `{ truncated: true, bytes, preview }`,
and `ContentPart[]` fields are always projected through `textOf` first
(`core/graph/utils/traceSanitize.ts`), so raw bytes never reach a trace event.

**`GET /api/graph`** (`tracing/structure/router.ts`, mounted next to the SSE route under
`TRACING`) returns the deployment's actually-compiled topology — nodes (with English
`labelKey`) and edges from `getGraphAsync({ xray: true })`, the same call
`02graphs/exportGraphs.ts` uses for mermaid diagrams. Label keys, not localized strings: the
structure is language-independent and cacheable; a client wanting localization already has it
on the SSE `label` channel, per job. `traceNode`'s emitted `nodeId` is the qualified path
LangGraph itself uses for a nested node (e.g.
`generation_phase:presentation_phase:chief_complaint_generate:generate_content`), not the bare
name passed to `traceNode` — two different subgraphs reuse bare names like `generate_content`,
so `TraceNodeFn.scope()` (`nodeWrapper.ts`) threads the same qualification LangGraph computes
at every point a compiled subgraph is mounted.

**OTel is a parallel, independent channel**, not the same mechanism as the label/trace stream
(the likely design mistake this issue called out explicitly): one span per node from the same
`traceNode` seam (`core/graph/utils/nodeWrapper.ts`'s `NodeTracer`/`NodeSpan` port), gated by
the standard `OTEL_SDK_DISABLED`/`OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_SERVICE_NAME` — never
`FEATURES=TRACING`. The concrete adapter (`tracing/otel.ts`) is the one place `@opentelemetry/*`
is imported and these env vars are read; core only knows the port (mirroring the
`registerJobHook` inversion already used for `TraceBus`). With the SDK disabled, the OTel SDK
is never constructed — a guarded dynamic `import()`, not a static one (see `tracing/otel.test.ts`).
Open question, deliberately unsolved: a checkpoint-resumed node (F09) re-executing produces two
spans for one logical step.

**Two defects fixed alongside this (issue 15 §2), each independently reviewable:**
`traceNode` (`nodeWrapper.ts`) now wraps the node call in `try`/`catch` — a throwing node used
to emit "Node Started" and nothing terminal; it now also emits "Node Failed" and rethrows. The
per-job `TraceBus` (`tracing/traceManager.ts`) no longer tears down on a hardcoded 10-second
timer — it tears down when the job reaches a terminal state **and** its last SSE consumer has
disconnected (`registerConsumer`/`unregisterConsumer`), with a generous timer kept only as a
backstop for a consumer that never disconnects.

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
- **`02presentation/`** — `generation/` generates a detailed case outline (the complete factual record of the case), then a combined outline evaluate ⇄ revise `Command` loop (max 2 iterations) judging obviousness AND clinical consistency in one LLM call; once accepted, fans out via `Send` to `patient_generate` / `chief_complaint_generate` / `anamnesis_generate` (gated per `generationFlags`), joining at `case_fan_in`. There is no post-fan-out consistency check. `chief_complaint_generate` and `anamnesis_generate` are **compiled subgraphs** (`chiefComplaintGraph.ts`, `anamnesisGraph.ts`), not function nodes — see "Modality Registry" below for their internal shape. `patient_generate` stays a plain function node: `patient` is not a `ContentPart[]` field (it stayed a structured `Patient` object through issue 11), so there is nothing for a modality provider to render — the `Send` payload (`{ diagnosis, outline, userInstructions }`) is identical across all three targets either way, whether the target is a function or a compiled subgraph.
- **`03procedure/`** — only when the `procedures` flag is set. A **blinded solver** loop (max 6 iterations) with exactly 3 nodes: `blinded_step` orders procedures without knowing the true diagnosis, `result_step` generates their results non-blinded; when the solver commits to a diagnosis, an LLM judge checks the match (loop continues with `ruledOutDiagnoses` on mismatch). On exhaustion, a `bridge` node generates confirmatory procedures for the true diagnosis. The approved procedure list is presented (and picked) grouped by category (`{ "Category": ["Name", …] }`, with uncategorized procedures under a synthetic `"General"` bucket) rather than as one flat list — this applies to both the blinded pick and the (non-blinded) bridge pick, the latter grouping full `{name, relevance, result}` objects per category. Procedure selection is a `ProcedureStrategy` port (`03procedure/strategy/`: `ports.ts`, `directPick.ts`, `categoryScopedPick.ts`, `index.ts`'s `createProcedureStrategy`) rather than a branch of a global config read inside the node — `blinded_step` and `bridge` call `strategy.nextStep()` / `strategy.bridge()` and never read `PROCEDURE_PRESELECTION` themselves; the strategy is selected once at graph-assembly time and threaded down as a constructed object. `DirectPick` is one LLM call against the full candidate list per step (the default). `CategoryScopedPick` — selected only when `PROCEDURE_PRESELECTION` is set **and** the approved list has real categories (a flat catalogue has nothing to scope on) — splits that single call into two sequential calls (a category-only pick, over-inclusive, followed by a procedure/results-only pick scoped to those categories plus `"General"`); the graph shape stays fixed at 3 nodes regardless of which strategy runs. The blinded scoped pick may answer with an `expand` action requesting additional categories: a bounded loop in `CategoryScopedPick.nextStep` unions them into a local scope set and retries (max 2 expansions per `blinded_step`; the expand grammar only admits categories not yet in scope, and past the cap the branch is removed from the schema entirely — the visited set lives in code, never the model). The bridge's scoped pick instead retries deterministically once with all categories if it returns empty. The blinded step's own compiled child graph (built once per strategy, invoked — not added as a node — from inside `blinded_step`) has a state schema that structurally omits `diagnosis`: the `BlindedView` type already makes passing it a compile error, and the child graph is a runtime backstop on top of that (LangGraph filters input against a graph's state schema before it reaches a channel). `matchDiagnosis` stays in the parent node, outside the blinded path, since it's an oracle call. Additional guards: already-ordered procedures are excluded from every candidate list/grammar (duplicate orders are impossible by construction), category-pick prompts show per-category counts plus sample names, and blinded prompts include the remaining iteration budget as convergence pressure.

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
`caseGraph.test.ts` asserts the premise still holds). Each topology gets the two views the
script already produced — detailed, and an overview with the translation phases collapsed.

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
  alt: string; // plain text: what this part conveys — the render request, retained
};
```

**Additive parts, all rendered.** The array is an ordered list of parts that together
_compose_ one field value — **not** a list of alternative renditions to choose between. Order
is meaningful, and an empty array is never a valid field value (`.min(1)` on the schema): a
field that exists has at least one part, a field that does not exist is absent.

**`value` is derived for text parts.** `textPart(alt)` is the only constructor for a
`text/plain` part — `value` is always `utf8(alt)`, never authored independently, so the two
cannot drift. **`textOf(parts)` is the only path from content parts to a prompt** —
`parts.map(p => p.alt).join("\n\n")`, with no MIME branching. Prompt builders take `string`,
never `ContentPart[]`; the `Presentation` type in `03aigateway/procedures.aigateway.ts` is a
text projection built by `presentationOf` (`03procedure/index.ts`), not the domain `Case`
shape — bytes must never reach a prompt. `utils/prompt.ts`'s `renderForPrompt(value: unknown)`
still accepts anything; that `unknown` is a known hole, not a guarantee.

**The LLM never emits bytes.** Field generators produce ordinary strings under their own
`z.string()`-based schemas (`ChiefComplaintJsonSchema`, `buildAnamnesisSchema`,
`ProcedureResultTextSchema`/`buildProcedureResultTextSchema`) — the domain `CaseSchema` (with
its `ContentPart[]` fields) is never used as an LLM output schema. The gateway wraps the raw
string with `textPart()` before returning the domain shape.

**Wire encoding** lives in exactly one place, `src/api/contentWire.ts` (`encodeCase`/
`decodeCase`, `CaseWireSchema`) — a boundary concern, not a domain one. `value` serializes to a
JSON string: UTF-8 verbatim for `text/*`, base64 for everything else; `alt` is omitted on the
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
`03case-translation-from-english/tools.ts`'s `caseAltMap`, keyed by stable **path**
(`chiefComplaint.0`, `anamnesis.2.answer.0`, `procedures.1.result.3`) rather than by name, so
translating a procedure's name can never collide with translating its result) run in parallel and
write to their own state channels, never to `case`. `translate_merge` is the only node that
applies both maps to `case`: for each part, a `text/plain` part has `value` **re-derived** as
`utf8(translatedAlt)` via `textPart()` (never translated independently, so the two cannot drift);
any other part's `value` passes through byte-identical, translating only `alt` — excluded from
re-derivation by construction, not by a prompt instruction. Because `alt` is the only thing that
ever reaches this prompt, and it is joined into a small keyed JSON object rather than the whole
case (patient object, procedure names, enums and all), the rest pass's payload shrinks
meaningfully too — see issue 12's PR for a representative measurement. This is also
what unblocks issue 13: per-part translation survives a multi-part field, where the old
whole-case text projection would have collapsed it.

### Modality Registry

`src/core/graph/modality/` (`ports.ts`, `registry.ts`, `pipeline.ts`, `providers/text.ts`)
mirrors `medicalBasis/`'s structure closely: a `ModalityProvider` port —

```ts
interface ModalityProvider {
  readonly id: string;
  readonly produces: string[]; // MIME types it can emit
  render(alt: string, ctx: RenderContext): Promise<Uint8Array>;
}
```

— with **no LLM assumption anywhere in it**. `RenderContext` is exactly `RequestContext`, not a
signal-only shape (the issue 14 lesson: a provider may need `llmConfig` under `ALLOW_LLMS`).
`createModalityRegistry()` (`registry.ts`) builds the deployment's list in the composition root
(`graph/index.ts`), **not** a `FEATURES` flag — it always returns `[textProvider]` today.
`textProvider` (`providers/text.ts`) is the degenerate case: `utf8(alt)`, no model call at all,
because the text was already produced by `generate_content`; a future image provider (e.g. a
diffusion model reached over MCP) satisfies the same interface. **Text is a normal registry
entry, not an implicit floor.**

`AssemblyDeps.modalityRegistry` (`02graphs/caseGraph.ts`), not `GraphFlags`, for the same reason
`medicalBasisRegistry` lives there: fixed per deployment, shared by all four flag variants. Its
_size_ decides whether `decide_modality` is compiled into `chiefComplaintGraph`/`anamnesisGraph`
(`02presentation/generation/`):

| Registry size | Compiled shape                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0             | Rejected immediately, at graph-assembly time (`EmptyModalityRegistryError`) — every graph variant is compiled eagerly at boot, so this fails the process at startup, never on the first request.                                                                             |
| 1             | `generate_content → render_parts` — no `decide_modality` node. `render_parts` synthesizes the plan directly (`pipeline.ts`'s `defaultPlanFor`): one request, in the sole provider's MIME, `alt` = the unit's whole canonical text.                                           |
| >1            | `generate_content → decide_modality → render_parts` — `decide_modality` (`03aigateway/modalityDecision.aigateway.ts`) is an LLM call planning an ordered list of `{ modality, alt }` render requests per content unit, drawn only from the registry's producible MIME types. |

Each field subgraph's `generate_content` node **reuses the existing gateway call and its
`z.string()`-based schema unchanged** — `textOf()` (`ContentPart.ts`) reads the canonical text
back out of the single text part the gateway already wraps it in, so no prompt changed to
support this. For anamnesis, `generate_content` produces one content unit per category and
reorders them to **catalogue order** before planning/rendering — the LLM's array order is not a
contract, and downstream prompts depend on category order staying stable.

`render_parts` (`pipeline.ts`'s `renderRequests`) calls every planned request's provider
concurrently and reassembles the result in **planned order, not completion order** — the same
shape as `medicalBasis/registry.ts`'s `resolveAllFragments`, for the same reason: otherwise the
same configuration produces different field content run to run. Tested with staggered fake
providers where the first-planned request resolves last.

**An image-only registry is safe by construction:** `generate_content` still runs unconditionally
and is never itself a registry entry, every part still carries its render request's `alt`, and
`textOf()` still returns prose regardless of which MIME types are registered — so the plan judge,
`matchDiagnosis` and the blinded solver all keep working even when no provider produces text.

**Known limitation, recorded rather than fixed (issue 13 §6):** rendering runs _inside_ each
field subgraph, i.e. before translate-out. With the translation sandwich on, a modality is
rendered from an **English** `alt`, and its bytes are never translated — only `alt` is (issue
12). Fine for the only kind of part that exists today (plain text, whose `value` is re-derived
from the translated `alt` anyway); not fine for a future image with burnt-in annotations, speech,
or any rendering where meaning lives in the bytes. The migration path stays open only because
`generate_content`, `decide_modality` and `render_parts` are distinct nodes in both field
subgraphs — moving rendering to a post-translation phase later is then a _move_, not a rewrite.
Do not collapse them into one node.

`procedures[].result` is also `ContentPart[]` (issue 11) but is produced in the procedure phase,
not the presentation fan-out — out of scope for issue 13, a natural follow-up.

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

`src/transports/rest/` (requires the `REST` feature flag). Routes translate protocol only —
generation goes through `CaseGenerationService`:

- `GET /api/health`, `GET /api/features`, `GET /api/allowedLlms`
- `routes/cases.router.ts` — `POST /api/cases` (aborts on client disconnect), `DELETE /api/cases/:jobId` (cancel)
- `routes/diagnosis.router.ts` — `GET /api/diagnosis`
- `routes/procedures.router.ts` — `GET /api/procedures`
- `src/tracing/sse/` — `GET /api/traces/:jobId/stream` (SSE, `event: label`/`event: trace`) and `GET /api/graph` (compiled topology, `tracing/structure/`), both mounted onto the REST app when `TRACING` is set

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

`runWithContext(fn, jobId?, llmConfig?, language?)` in `src/core/graph/utils/context.ts` uses `AsyncLocalStorage` to propagate `jobId`, optional `llmConfig`, optional `language` and an abort `signal` through the entire async call chain, and registers an `AbortController` with `cancelManager` (`utils/cancelManager.ts`) so generations can be cancelled by jobId. Graph nodes read it via `getRequestContext()` — `RequestContextSchema` also doubles as LangGraph's own runtime-context schema at every `new StateGraph(state, RequestContextSchema)` call site, but `language` is never read from _that_ copy (see Language below); only `getRequestContext()` (ALS) is the real read path.

Core does not import the tracing module: `registerJobHook()` is a core-owned registry the
`tracing` module registers against. With `TRACING` unset nothing is registered and no
per-job trace bus is allocated. `NodeTracer`/`NodeSpan` (`utils/nodeWrapper.ts`, issue 15 §5)
is the same inversion applied to OTel: core owns the port, `tracing/otel.ts` implements it,
`app.ts` wires the two together.

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

| Variable                                                   | Default                 | Notes                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                     | `3030`                  | Server port                                                                                                                                                                                      |
| `FEATURES`                                                 | `""`                    | Comma-separated flags: `REST`, `NATS`, `TRACING`, `DEBUG`, `ALLOW_LLMS`                                                                                                                          |
| `LLM_PROVIDER`                                             | —                       | `ollama` \| `google` \| `openai` (required unless `ALLOW_LLMS`)                                                                                                                                  |
| `LLM_MODEL`                                                | —                       | Model name (required unless `ALLOW_LLMS`)                                                                                                                                                        |
| `LLM_API_KEY`                                              | —                       | API key for Google/OpenAI                                                                                                                                                                        |
| `LLM_URL`                                                  | —                       | Override base URL (e.g. local Ollama or OpenAI-compatible endpoints)                                                                                                                             |
| `LLM_GENERATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`  | —                       | Optional per-field override for the `generator` role; unset fields fall back to the general `LLM_*` value                                                                                        |
| `LLM_JUDGE_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL`      | —                       | Optional per-field override for the `judge` role (same per-field fallback)                                                                                                                       |
| `LLM_TRANSLATOR_PROVIDER` / `_MODEL` / `_API_KEY` / `_URL` | —                       | Optional per-field override for the `translator` role (same per-field fallback)                                                                                                                  |
| `TRANSLATION_SANDWICH`                                     | `true`                  | `false`/`0` compiles the translation phases out of the graph entirely                                                                                                                            |
| `PROCEDURE_PRESELECTION`                                   | `false`                 | `true`/`1` selects the `CategoryScopedPick` procedure strategy (splits the blinded procedure step into a category pick then a procedure pick)                                                    |
| `LANGUAGES`                                                | `English,German`        | Comma-separated deployment language set, trimmed/de-duplicated/order-preserved; must include `English`. Validated at startup and against every request's `language` (see Language section below) |
| `LANGUAGE_AUTO_DETECT`                                     | `false`                 | `true`/`1` enables steps 2–3 of the language-detection ladder for a request that omits `language` (see Language section below); not a graph flag                                                 |
| `LANGUAGE_DETECT_LLM_FALLBACK`                             | `false`                 | `true`/`1` additionally enables step 3 (one LLM call) when the offline detector is below threshold; ignored unless `LANGUAGE_AUTO_DETECT` is also set                                            |
| `ALLOWED_LLMS`                                             | —                       | Format: `ollama:model1,google:model2` (requires `ALLOW_LLMS` flag)                                                                                                                               |
| `CATALOG_DIR`                                              | `data`                  | Deployer-owned, read-only catalogue inputs (YAML/JSON config files); resolved absolute against `process.cwd()` when relative                                                                     |
| `CACHE_DIR`                                                | `data/cache`            | Generated, writable output — the embedded SQLite database (`aetiomed.db`) lives here; resolved absolute against `process.cwd()` when relative                                                    |
| `NATS_URL`                                                 | `nats://localhost:4222` | `nats://nats:4222` in docker compose                                                                                                                                                             |
| `NATS_USER` / `NATS_PASSWORD`                              | `nats` / `nats`         |                                                                                                                                                                                                  |
| `SYMPTOM_CACHE_TTL_DAYS`                                   | `30`                    | TTL for cached LLM-generated symptoms (see `symptoms/repo.ts`)                                                                                                                                   |
| `MAX_CONTENT_PART_BYTES`                                   | `5000000`               | Ceiling on one `ContentPart.value`'s decoded byte size; encoding a larger part fails loudly (see `api/contentWire.ts`)                                                                           |
| `OTEL_SDK_DISABLED`                                        | unset (enabled)         | Standard OTel var. `"true"` skips constructing the OTel SDK entirely (no dynamic import even happens — see `tracing/otel.ts`); independent of `FEATURES=TRACING`                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                              | —                       | Standard OTel var, read by the OTLP exporter itself — no plumbing in this repo                                                                                                                   |
| `OTEL_SERVICE_NAME`                                        | —                       | Standard OTel var, read via `envDetector` (`tracing/otel.ts`)                                                                                                                                    |

Note: the `REST` flag is required for the HTTP API to load — include it in `FEATURES` when running the server.

## Path Aliases

`@/*` → `src/*` (configured in `tsconfig.json`; resolved at runtime by `tsx`, at build time by `tsc-alias`).
