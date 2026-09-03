# AetioMed — Engineering Review

**Date:** 2026-08-18 · **Branch:** `prefilter-categories` · **Scope:** `src/`

This document merges the two earlier reviews (`Review.md`, pre-refactor code quality; `design-review.md`, graph/prompting design) into a single record. Every finding below was re-verified against the current code. Items that the refactors resolved have been removed from the body and are listed in [§7](#7-resolved-since-the-earlier-reviews) so they don't get re-raised.

---

## 1. Executive Summary

The architecture is well matched to the problem, and the current design is a clear improvement over a single mega-prompt or a free-form agent loop — especially on small local models. The strongest ideas in the codebase:

- **Outline-as-blueprint.** A single source of truth fanned out to field generators is the correct decomposition. Each LLM call gets one job, a small output, and shared context.
- **The blinded procedure solver.** Generating the workup via self-play — a solver that doesn't know the answer, an oracle that does — yields procedures that are *evidence-justified*, and implicitly proves the case is solvable.
- **Constraint by construction.** Already-ordered procedures are removed from the grammar, the expand branch is deleted from the schema at the cap, and relevance is structurally unavailable to the blinded solver. These are enforced in types and data shape rather than in prompt text — the right instinct throughout.
- **Generate → judge → revise loops with iteration caps**, and the Tool/gateway/repo layering with Zod-validated boundaries.

The main weaknesses, in order of importance:

1. **A cluster of small latent bugs** that fail silently in production ([§2](#2-bugs-and-latent-defects)) — a Redis config that is never loaded, an unawaited NATS handler, a dropped `difficulty`, and an extension wired to an event nobody publishes.
2. **LLM judges do work that code should do first** (diagnosis-name leaks, impossible biometrics, exact-match diagnosis comparison). On a small model the judge is the least reliable component.
3. **Gateway boilerplate is ~60% of every file**, which makes retry/backoff/timeout policy inconsistent and impossible to fix in one place.
4. **The `procedures`-only path and the translation fan-out have real logic holes** (§3.4, §3.5).
5. **No evaluation harness.** For a pipeline whose entire purpose is artifact quality, there is no way to detect a regression when `LLM_MODEL` changes.

---

## 2. Bugs and Latent Defects

Verified present in the current code. Most are one-liners.

### 2.1 `loadConfig()` is never called — Redis ignores `REDIS_URL`

**`src/extensions/persistency/config.ts:15`** defines `loadConfig()`; nothing calls it. `persistencyConfig` therefore stays `undefined`, and `redis.ts` calls `createClient({ url: undefined })`, which silently falls back to `localhost:6379`. A deployment pointing `REDIS_URL` at a real host connects to nothing and reports success.

**Fix:** call `loadConfig()` at the top of `persistency/index.ts`'s `setup()`, or drop the module-level singleton and use the extension's own parsed `envSchema` config (which already declares `REDIS_URL`).

### 2.2 NATS handler is not awaited

**`src/extensions/nats/cases.handler.ts:181`** — `consumeCaseGenerateMessage(msg)` is invoked without `await` inside the `for await` loop. The loop advances to the next message immediately, so `ack`/`nak` races against the next iteration and generations pile up concurrently with no bound. With `max_messages: 1` the intent was clearly serial consumption.

**Fix:** `await consumeCaseGenerateMessage(msg);`

### 2.3 The NATS path silently ignores `difficulty`

**`src/extensions/nats/cases.handler.ts`** destructures `icd, userInstructions, generationFlags, language, llmConfig` and calls `generateCase(..., language)` — omitting the fifth argument. `CaseGenerationRequestSchema` accepts `difficulty`, so a NATS client can send it, get no error, and receive a `medium` case regardless. The REST route passes it correctly, so the two transports silently disagree.

**Fix:** destructure `difficulty` and pass it through.

### 2.4 `tracingPersistency` listens for an event nobody emits

**`src/extensions/tracingPersistency/index.ts`** subscribes to `"Trace Persistence Request"`. Nothing in `src/` ever emits that event (nor the declared `"Trace Completed"`). The extension loads, mounts its routes, and writes nothing — so `GET /api/traces` and `GET /api/traces/:jobId` always return empty. Because its `requiredFlags` is `[]`, it loads silently whenever `rest`+`persistency`+`tracing` do, which makes the dead path look live.

**Fix:** either have the `tracing` extension emit `Trace Persistence Request` alongside its per-job bus emission, or subscribe directly to the lifecycle events the way `tracingNats` does.

### 2.5 Redis client caches `null` permanently

**`src/extensions/persistency/redis.ts`** — on a failed connect the `.catch` resolves to `null`, but `redisClientPromise` stays assigned. Every later call gets the cached `null`; recovery requires a process restart.

**Fix:** clear `redisClientPromise` in the failure path so the next call retries.

### 2.6 Retry backoff is zero at every call site

All 15 `retry(...)` invocations pass `baseDelayMs = 0`, so `retry.ts`'s exponential backoff computes `0 * 2^n = 0` forever. Against local Ollama that's fine — failures are schema violations and immediate retry is correct. Against Google/OpenAI a 429 burns both attempts instantly.

**Fix:** make the delay provider-aware inside the shared helper (§5.2) rather than a constant repeated at 15 sites.

### 2.7 `generateDiagnosisToEnglish` has no retry at all

**`src/core/graph/03aigateway/diagnosis.aigateway.ts`** is the only gateway that calls `.withStructuredOutput().invoke()` bare. A single malformed response fails the whole generation at its very first step, before any other work has been done.

### 2.8 Zod v3/v4 split is a live hazard

`models/Case.ts`, `models/Anamnesis.ts`, `03repo/anamnesis.repo.ts`, and `extensions/api/CaseGenerationRequest.ts` import `zod/v4`; their siblings import `zod`. The tell is the workaround comment in `02graphs/02case-generation/03procedure/tools.ts`: *"Inlined to avoid importing AnamnesisSchema (zod/v4) into a zod v3 file."* That inlined `PresentationSchema` will silently drift from the real `Anamnesis` shape the moment the anamnesis model changes.

**Fix:** unify on one import path across `models/` and delete the duplicate schema.

---

## 3. Graph Design and Generation Logic

### 3.1 The overall shape is right

`translate-in → symptoms → outline → evaluate-loop → parallel field fan-out → blinded procedure solver → translate-out` is a sensible pipeline. Two properties are worth calling out as *correct*:

- The blinded solver never sees the outline or diagnosis, while `result_step` and `bridge` do. The information asymmetry is enforced through function signatures and data shape, not convention.
- Difficulty is decided once, in the outline's *Workup / Procedure Results Strategy* section, and downstream stages *follow* it rather than re-deciding it.

### 3.2 The solver's success signal is thrown away

When the blinded solver diagnoses correctly on iteration 1–2, that is direct empirical evidence the case is too easy; when it exhausts all 6 iterations and needs the bridge, the case may be too hard or the presentation incoherent. Today this signal only decides control flow.

**Suggestion:** record `solverIterationsUsed` / `bridged: boolean` on the result, even as metadata. It's a free ground-truth difficulty measurement — arguably more trustworthy than the obviousness judge, since it measures *actual solvability* rather than a model's opinion. Longer term it feeds the eval harness (§6.4).

### 3.3 Wrong-guess handling leaks oracle knowledge

On a wrong commit the name goes into `ruledOutDiagnoses` and the solver is told "do NOT propose any of these again." Clinically, ruling out a diagnosis requires a discriminating test — here the solver is simply *told* by the oracle. The generated procedure chain then contains an invisible reasoning step the student never sees.

**Suggestion:** on a wrong guess, have the non-blinded side generate the discriminating procedure whose result rules that diagnosis out, append it to the case, and let the solver continue from that evidence. Wrong guesses become pedagogically valuable red-herring workup — exactly what a `hard` case wants.

### 3.4 A `procedures`-only request gives the solver an empty patient

`caseGenerationGraph` always runs the presentation phase, and `buildFieldGenerationSends` produces zero `Send`s when none of patient/chiefComplaint/anamnesis is flagged. With `generationFlags: ["procedures"]`:

- You still pay for outline generation plus up to two evaluation rounds, and the fan-out then produces nothing.
- `presentationOf(state.case)` is `{}`, so the blinded solver — whose entire prompt is *"reason purely from the patient's presentation"* — reasons from nothing.

**Fix:** either declare the presentation fields prerequisites of `procedures` and validate at the API boundary, or inject the outline's presentation summary into the solver when the case has no generated fields. The first is simpler and probably matches the product reality.

### 3.5 Translation fan-out: controlled translations get overwritten

In `03case-translation-from-english/index.ts` the targeted translators (anamnesis categories, procedure names — cache-backed, controlled vocabulary) run **before** `translate_values`, which re-translates the whole case via free-form LLM and returns a full `Case` that replaces `case.anamnesis` and `case.procedures` wholesale through the shallow reducer merge.

The prompt says *"translate only the VALUES, do not translate keys"* — but categories and procedure names **are** values (the `category:` and `name:` fields), so the LLM re-translates them and its output wins over the controlled vocabulary. The controlled pass currently only *biases* the input; it guarantees nothing.

**Fix:** invert the order — run `translate_values` first, then apply the cache-backed translators as overrides — or strip categories and procedure names from the case handed to `translate_values` and re-attach afterward. *(Both earlier reviews flagged this; both refactors preserved the ordering.)*

### 3.6 Smaller structural notes

- **Single-node subgraphs.** `symptomsGraph` and `caseTranslationToEnglishGraph` wrap one node each, and the latter's `Send` of the whole state from `START` is a no-op. Fine if you value diagram symmetry; otherwise plain nodes would do.
- **No checkpointer.** A crash 15 LLM calls into a generation loses everything. You already run SQLite through Drizzle; LangGraph's SQLite checkpointer would give resume-on-failure almost for free, and is the standard answer for long multi-call graphs.
- **Call-count budget.** Worst case is roughly 1 outline + 2 evaluations + 2 regenerations + 3 fields + ~6 solver + ~6 result + match calls + bridge ≈ **20+ LLM calls per case**, and the `LLM_SMALL` split roughly doubles the procedure-phase calls. On a local 8B model that's minutes per case. Worth documenting per-request, and worth exposing the caps (`OUTLINE_EVALUATION_MAX_ITERATIONS`, `SOLVER_MAX_ITERATIONS`, `MAX_CATEGORY_EXPANSIONS`) as config rather than constants scattered across three files.
- **Parallel fan-out vs. Ollama.** The three-way `Send` fan-out runs concurrently, but a default Ollama instance serializes requests (`OLLAMA_NUM_PARALLEL=1`) — you get the complexity of parallelism without the local speedup. Not wrong (cloud providers benefit), just know it.
- **Empty pick → bridge.** `blindedStep` treats `action: "procedure"` with an empty array as "nothing left to order → bridge". Defensible and now documented, but a single retry-with-feedback would match the pattern used everywhere else.
- **Array state has no reducers.** `symptoms`, `ruledOutDiagnoses`, and `pendingProcedures` use default replacement. Safe today, since no two nodes write them concurrently — but a future parallel branch writing `symptoms` would silently clobber. Worth registering an explicit reducer to document the intent.

---

## 4. Prompting for Small Local Models

### 4.1 What's already good

- One narrow task per call; structured output via `withStructuredOutput`, grammar-constrained on Ollama — the single most effective reliability tool for small models.
- The **grammar/prompt split**: the full literal-union constraint goes to the provider while a name-agnostic schema goes into the prompt, with `renderSchemaForPrompt` collapsing unions over 8 members. Prompts stay short and stable; the constraint stays exact.
- Retry with a *summarized* previous error fed back into the prompt.
- Restricted vocabularies enforced in both prompt and schema.
- Keyed-translation format with missing-key detection and targeted retry.
- Temperature split by task type (0.1 deterministic / 0.4 balanced / 0.7 creative).

### 4.2 Judges: give code the first pass

Both the outline judge and `matchDiagnosis` are the same small model judging its own output — the weakest link in the loop, and small models are poor calibrators of "too obvious."

- **Diagnosis-name leak** is the #1 criterion of the outline judge, and it is a string search. Check `diagnosis.name` + `alternativeNames` (case-insensitive, word-boundary) against the outline **in code** before ever calling the judge. Deterministic, free, 100% recall on the most embarrassing failure mode.
- **Impossible biometrics** — the judge prompt's own example is "a 2-year-old weighing 70kg" — is arithmetic. Validate in code, or better, encode age-appropriate ranges as `PatientSchema` refinements so the structured-output retry loop fixes it automatically.
- **`matchDiagnosis` should short-circuit** on an exact or `alternativeNames` match before spending an LLM call. This runs on every solver commit.
- Reserve the LLM judge for what genuinely needs judgment (clinical coherence, gestalt obviousness). Its output contract — boolean + reasons + one actionable suggestion — is a good shape; keep it.

This "deterministic validators → LLM judge" layering is the standard recipe for making small-model pipelines reliable, and every data model needed to do it already exists.

### 4.3 Prompt-section ordering vs. the prefix cache

Data now lives in the user message and the system prompt is stable across calls of the same type — the important half of this is done. What remains is ordering *within* the user prompt.

The blinded solver is called up to 6× per case. Its user prompt runs presentation → candidates → instructions → previous procedures → budget. The candidate list shrinks every iteration (ordered procedures are filtered out), which invalidates the KV cache for everything after it — including the otherwise-static instructions.

**Refinement:** order user-prompt sections stable-first, most-recently-changed last: presentation → additional instructions → candidates → previous procedures → budget.

---

## 5. Architecture and Layering

### 5.1 The Tool layer doesn't yet earn its keep

`02graphs` (control flow) → tools (named capabilities) → `03aigateway` (prompts + LLM) → `03repo` (data) is clean and readable. But today the `Tool` layer is nearly pure pass-through: `inputSchema` is declared and **never used to validate** — `invoke` is called directly with the raw object — and most tool bodies are a one-line delegation that re-orders named arguments into positional form.

Two coherent options:

- **Make it earn its keep:** a `createTool()` factory that parses input through `inputSchema`, turning the declared schemas into real runtime contracts. If MCP exposure is the plan (per the docstring), this is the natural seam for it. While there, switch gateway signatures from 5–6 positional arguments — `generateBlindedProcedureStep(presentation, previousProcedures, ruledOutDiagnoses, userInstructions, iterationsRemaining, context)` is the warning sign — to a single options object.
- **Or drop it** and let nodes call gateways directly.

The current halfway state is boilerplate without enforcement.

### 5.2 Gateway boilerplate is ~60% of every file

Each of the ~15 gateway functions hand-rolls the identical sandwich: build prompts → `console.debug` prompts → `retry(async … withStructuredOutput().invoke([System, Human + errorFeedback]) … console.debug response …, 2, 0, emit-error-to-bus)` → try/catch/log/rethrow. `translate.helper.ts` already proves the abstraction works.

```ts
callStructuredLLM({
  logTag,
  system,
  user,
  schema,
  mode: "creative" | "balanced" | "deterministic",
  context,
});
```

This would delete several hundred lines and — more importantly — give retry, backoff, abort-signal, and timeout policy **one** place to live. The consistency problems in §2.6 and §2.7 exist precisely because there are 15 copies of the policy.

The same applies to the `bus.emit("Generation Log", { msg, logLevel, timestamp: new Date().toISOString() })` ceremony repeated ~30 times across graph nodes; a two-line `log.info(msg)` helper that stamps the timestamp would visibly shrink every node file.

### 5.3 Two leaks between core and extensions

The stated contract is that the graph is core, extensions are plugins, and communication runs one way over the bus. Two places break it:

**Core imports an extension.** `src/core/graph/utils/context.ts` imports `setupTracing` from `@/extensions/tracing/traceManager.js`. `runWithContext` therefore builds a per-job `TraceBus` on **every** request whether or not the `TRACING` flag is set — the extension only decides whether anything is pushed into it. So core depends on an extension's module, and tracing infrastructure allocates even when tracing is disabled.

**Fix:** invert it. Have the `tracing` extension register a hook on the bus (or a small core-owned registry) that `runWithContext` calls if present, so core depends on nothing under `extensions/`.

**Trace-label translation reaches across layers.** `utils/nodeWrapper.ts` resolves labels through `03repo/labels.repo.ts`, and `generateCase` warms that cache before invoking the graph. A `utils/` helper on the trace hot path is coupled to the data layer, and a translation concern has become a precondition of case generation.

**Fix:** treat label localization as a presentation concern of the consumer (`tracingNats` / `tracingRest` are the only consumers of `label`), and emit raw English labels from core.

Related: several gateways import `bus` from `@/core/graph/index.js` — a layer-03 file reaching up to the module root. The numbered-directory convention documents the intended call direction but nothing enforces it. Either enforce it (`eslint-plugin-import`'s `no-restricted-paths`, or `dependency-cruiser`) so violations fail CI, or drop the prefixes.

### 5.4 Terminal lifecycle events are emitted by transports, not the graph

`Generation Completed`, `Generation Failure`, and `Generation Cancelled` are emitted by `cases.router.ts` and `cases.handler.ts` — not by the graph. Any future caller that invokes `generateCase` without going through a transport gets none of them, which means `persistency` silently doesn't save that case and `tracing` never sees a terminal event.

This is defensible (the transport is the only layer that knows whether the *whole request* succeeded), but it is load-bearing and undocumented. Either document it as the contract or move terminal emission into `runWithContext`, which already wraps the full lifecycle and has the `jobId`.

### 5.5 Extension framework

- **`dep()` is dead code.** `defineExtension` offers `ctx.dep(otherExt)` to retrieve a resolved sibling's config; there are zero call sites. Extensions import siblings directly at module level instead — `persistency`, `swagger`, `tracingRest`, and `tracingPersistency` all import the mutable `apiRouter` binding from `rest`. The loader's dependency graph and the real import graph therefore describe different things. Either delete `dep()` or route shared resources through it; the latter also fixes §2.1.
- **Module-level mutable singletons.** `core/graph/index.ts` exports `export let config` and `export let bus`, assigned in `initGraph()`. Any import-time code path sees `undefined` — `CaseGenerationRequestSchema` reads `config.llm` inside `.refine()` callbacks, which works only by luck of load order and makes the schema non-composable.
- **Import-time side effects.** `diagnosis.repo.ts`, `procedures.repo.ts`, `anamnesis.repo.ts`, and `symptoms.repo.ts` all run their sync/preload at module scope, and `db.ts` runs `mkdirSync` + `migrate()` on import. Filesystem writes and YAML parsing happen before any `setup()`, before tests can inject mocks, and before Docker volumes are guaranteed mounted on a cold start.
- **Routing namespace collisions are invisible.** Four extensions mount at `apiRouter.use("/", router)`. Resolution order depends on the topological sort. A new extension registering `/cases` would shadow the existing route with no error. Require each extension to declare a path prefix so conflicts surface at startup.
- **`EventBus` string-fallback overloads** (`on(event: string, …)`) mean a typo'd event name type-checks fine and silently never fires. Drop them so `EventMap` is the only way in.

### 5.6 Case type loses its invariants

`CaseSchema` marks all four fields optional. A fully generated case always contains exactly the fields named in `generationFlags`, but the type system can't express that, so every consumer null-checks everywhere. Consider separating `DraftCase` (all optional) from a flag-parameterized `GeneratedCase<Flags>`.

---

## 6. Observability, Reliability, and Evaluation

### 6.1 Logging volume

`caseGraph.invoke`'s result is `console.log`'d as full JSON **twice** per run (once on entry, once on completion), on top of every prompt and every raw LLM response being `console.debug`'d in each gateway. Production log volume will be substantial and will contain the full case. Gate this behind the `DEBUG` feature flag that already exists.

### 6.2 No latency or token accounting

Nothing records call duration or `usage_metadata`. The shared `callStructuredLLM` helper (§5.2) is the natural place to add both — and with per-request LLM selection, cost attribution per job is otherwise unrecoverable.

### 6.3 Reliability gaps

- **Trace cleanup keeps a live timer.** `traceManager.ts`'s `setTimeout(..., 10000)` holds the `TraceBus` and its listeners for 10s after the request ends and keeps the event loop alive, delaying clean process exit. Clean up on SSE stream close (`res.on("close", …)`) and `.unref()` the fallback timer.
- **No LLM client timeout.** No provider client is configured with one. A hung Ollama holds the connection indefinitely; the request-scoped `AbortSignal` covers cancellation but not a silently stalled call.
- **NATS `ack_wait` is 10 minutes with no heartbeat.** Long generations never call `msg.working()` to extend the window, so under load NATS may redeliver a message that is still being processed. Combined with §2.2 this compounds.
- **`handleLangchainError` catches too little.** Only `fetch failed` / `ECONNREFUSED` map to `ModelUnreachableError`. Rate limits (429), auth failures (401), and context-length overflows fall through as raw `Error` and surface as opaque 500s.

### 6.4 The evaluation gap

There is excellent *tracing* — bus events, `traceNode`, per-node labels, localized labels — and no *evaluation*. For a pipeline whose entire purpose is the quality of generated artifacts, the missing piece is a small harness: ~20 diagnoses × difficulties, run through the pipeline, scored by

1. code checks (name leak, schema completeness, biometric plausibility),
2. the solver-iterations metric from §3.2, and
3. optionally a strong cloud model as grader.

This is what turns prompt tweaking from vibes into engineering. It matters especially here because judges and generators are the **same** small model, so the pipeline structurally cannot detect its own systematic blind spots — and it's the only thing that will give regression protection when `LLM_MODEL` changes.

### 6.5 Dead code

`utils/llm.ts` exports `decodeObject`, `parseStructuredResponse`, `parseStructuredResponseAgent`, and `getSearchTool` with zero call sites; `utils/context.ts` exports an unused `getRequiredRequestContext`. `getSearchTool` additionally supports only Ollama and Google and mixes tool-building into an LLM factory. Adopt or delete.

---

## 7. Resolved Since the Earlier Reviews

Recorded so these aren't re-raised. All verified fixed in the current code.

| Earlier finding | Status |
| --- | --- |
| Single-field vs. multi-field pipeline split (quality gap + ~360 lines duplicated) | Removed; one pipeline |
| UMLS symptoms discarded after lookup | Now unioned with LLM additions, plus a TTL cache that skips the LLM on a hit |
| Symptom retrieval split across two graph nodes instead of one cache-aside step | Single `symptoms_resolve` node |
| Whole-case regeneration in the inconsistency fixer | Inconsistency phase removed entirely |
| Inconsistency judge blind to difficulty/outline, undoing intentional distractors | Judging moved onto the outline, with explicit "distractors are intentional" instruction |
| No validation of the outline before parallel field generation | Combined obviousness + consistency evaluate ⇄ revise loop, pre-fan-out |
| `outlineRegenerate` didn't pass the rejected outline | `previousOutline` + `feedback` now threaded through |
| `relevance` demanded from the blinded solver | Moved to the non-blinded `result_step` |
| `procedureGraph` was a no-op stub | Fully implemented 3-node solver |
| Top-level graph recompiled on every request | Compiled once at module load |
| State mutation inside nodes; passthrough `iteration_check` nodes; manual counter+back-edge loops | Replaced by `Command`-based loops |
| `Send` payloads carrying full untyped parent state | Field fan-out slices to `{diagnosis, outline, userInstructions}` |
| `userInstructions` leaking as `[string, unknown][]` into prompts | `renderUserInstructions` / `filterUserInstructions` |
| Prompt style inconsistent (raw templates, `{role, content}` objects) | All gateways use `buildPrompt` + `SystemMessage`/`HumanMessage` |
| `buildPrompt` joined sections with a single `\n` | Joins with `\n\n`; `section()` adds `##` headers |
| `"Schema:"` followed by a concrete example instance | `renderSchemaForPrompt` derives a real pseudo-schema from Zod |
| Raw one-line `JSON.stringify` as prompt payload | `renderForPrompt` emits readable YAML |
| Enormous raw Zod error dumps fed into retry prompts | `summarizeValidationError` |
| Full procedure list re-sent every solver iteration | Category grouping, `LLM_SMALL` scoping, and ordered-procedure filtering |
| `generateBlindedProcedureStep` not passing `signal` to `.invoke()` | Signal threaded through all gateways |
| Prompt-example helpers and hand-typed pseudo-schemas living in `models/` | Models export only schema and type |
| Translation cache-aside duplicated across three services | Generic `createTranslationStore` + `translate.helper.ts` |
| `z.literal(stringArray)` not matching elements | Valid in Zod v4 |
| Publisher not setting `Nats-Msg-Id` | Set, plus a stream-level `duplicate_window` |
| Imports from the top-level `langchain` convenience package | All from `@langchain/core/*` |
| `cases.service.ts` pass-through layer | Deleted; routers invoke the graph directly |

---

## 8. Prioritized Recommendations

### Do first — small, high value

1. Fix the §2 bugs: call `loadConfig()` (§2.1), `await` the NATS handler (§2.2), pass `difficulty` through NATS (§2.3), and either wire or remove `tracingPersistency` (§2.4).
2. Add deterministic pre-validators ahead of the LLM judges: name-leak string check, biometric range check, exact-match short-circuit in `matchDiagnosis` (§4.2).
3. Fix the translation fan-out ordering so the controlled vocabulary actually wins (§3.5).
4. Add a retry to `generateDiagnosisToEnglish` (§2.7).

### Medium — structural

5. Extract `callStructuredLLM` (§5.2), and use it to fix backoff (§2.6), add timeouts and token accounting (§6.2, §6.3) in one place.
6. Decide the `procedures`-only contract and enforce it at the API boundary (§3.4).
7. Close the two core↔extension leaks (§5.3) and document or relocate terminal-event emission (§5.4).
8. Unify the Zod import path and delete the inlined `PresentationSchema` (§2.8).
9. Record solver iterations as a difficulty metric (§3.2).

### Longer term

10. Eval harness over a golden diagnosis set (§6.4) — the highest-leverage item on this list for output quality, and the prerequisite for changing models with confidence.
11. SQLite checkpointer for resumability (§3.6).
12. Rule out wrong guesses via discriminating procedures instead of oracle blacklisting (§3.3).
13. Make the Tool layer validate its inputs, or drop it (§5.1); enforce the layer convention with a lint rule (§5.3).
14. Fix the extension framework's structural gaps: `dep()`, module singletons, import-time side effects, router prefix collisions (§5.5).
