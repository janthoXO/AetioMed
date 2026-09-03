# 04 — Graph runtime and port bundle

**Depends on:** 01 · **Blocks:** 05, 06, 07, 08, 09, 14
**Design ref:** `architecture-target.md` §2, §9

## Why

`src/core/graph/index.ts:42-43` exports two mutable module singletons:

```ts
export let config: Config;
export let bus: EventBus;
```

assigned later in `initGraph()`. **17 modules import them.** Any import-time code path sees `undefined` — `extensions/api/CaseGenerationRequest.ts:47-53` reads `config.llm` inside three `.refine()` callbacks, so the _public request schema_ works only by luck of load order.

This is also why there is no way to construct the graph with a fake LLM: `utils/llm.ts:19` imports `config` from module scope, so `getLLM()` has no injection seam. Every guarantee in issues 06, 07, 09 and 14 is untestable until this changes.

## Current state

- `core/graph/index.ts:42-43` — the singletons
- `utils/llm.ts:19` — `import { config } from "@/core/graph/index.js"`
- `utils/context.ts:7` — `import { setupTracing } from "@/extensions/tracing/traceManager.js"` — **core importing an extension**, and it builds a per-job `TraceBus` on every request whether or not `TRACING` is enabled
- 51 hand-rolled `bus.emit("Generation Log", { msg, logLevel, timestamp })` call sites
- Import-time side effects: `03repo/db.ts:30,32,38`; `03repo/symptoms.repo.ts:38`; `03repo/diagnosis.repo.ts:112`; module-scope `createTranslationStore(...)` calls

## Task

### 1. Define the runtime

```ts
// src/core/graph/runtime.ts
export interface GraphRuntime {
  llm: LlmPort; // roles land here in issue 06
  catalogs: {
    procedures: ProcedureCatalog; // issue 01
    anamnesis: AnamnesisCatalog;
    labels: LabelCatalog;
    diagnosis: DiagnosisCatalog;
  };
  log: Logger; // info/warn/error, stamps the timestamp
  clock: () => Date; // so tests can freeze time
}
```

### 2. Construct once, in the composition root

`createApp()` in `src/core/app.ts` builds the runtime and passes it into graph assembly. Nothing under `src/core/graph/` may read `process.env` or import a module singleton after this.

### 3. Thread it without polluting every signature

Ports are captured by **closure at assembly time**, not passed through every call. Where a node genuinely needs per-request access, use the existing `AsyncLocalStorage` in `utils/context.ts` — **not** LangGraph's runtime context.

**Why not the LangGraph context:** `RequestContextSchema` is a Zod schema that LangGraph validates, so putting port _functions_ in it means loosening it to `z.custom`. Carrying ports in ALS avoids that. Note the trade-off for later: ALS-carried ports are invisible to checkpoints, so anything resumable (F09) must rebuild them.

### 4. Collapse the logging ceremony

Replace all 51 `bus.emit("Generation Log", {...})` sites with `runtime.log.info(msg)`. The logger stamps the timestamp and emits the bus event. Keep the event on the bus — tracing depends on it.

### 5. Invert the tracing import

`utils/context.ts` must not import from `@/extensions/`. Have the tracing extension **register a hook** on a small core-owned registry that `runWithContext` calls if present. When `TRACING` is off, nothing is registered and no `TraceBus` is allocated.

### 6. Make `getLLM` injectable

`getLLM()` takes its configuration from the runtime rather than the module singleton. This is what makes "zero LLM calls when the registry is empty" (issue 14) a testable claim: a fake `LlmPort` can count invocations.

### 7. Move import-time side effects behind constructors

DB open, migration, YAML sync and the 2.6 MB JSON parse move into functions called from `createApp()`. This is what unblocks importing `03repo/` modules in tests (issue 00).

## Acceptance criteria

- [ ] `src/core/graph/index.ts` exports no mutable bindings
- [ ] `grep -rn "core/graph/index.js" src/` shows no imports of `bus` or `config`
- [ ] `grep -rn "@/extensions" src/core/` returns nothing
- [ ] `grep -rn "process.env" src/core/graph/` returns nothing
- [ ] Importing any `03repo/` module performs no I/O
- [ ] With `TRACING` unset, no `TraceBus` is constructed (assert with a spy)
- [ ] A test constructs a `GraphRuntime` with a fake `LlmPort` and an `InMemoryProcedureCatalog`, runs a node, and asserts the call count
- [ ] `bus.emit("Generation Log"` appears in exactly one place

## Out of scope

Deleting extensions (05), LLM roles (06), graph assembly (08). Keep this PR mechanical.
