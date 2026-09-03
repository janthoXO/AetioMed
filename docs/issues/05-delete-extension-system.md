# 05 — Delete the extension system

**Depends on:** 04 · **Blocks:** 08, 11
**Design ref:** `architecture-target.md` §3, §8, §9

## Why

The extension framework's own dependency mechanism is unused, extensions reach each other by importing mutable bindings, one extension has never worked, and route mounting is order-dependent. After deleting the extensions that are going away, what remains _is_ the communication layer — constructed explicitly in ~30 lines.

## Current state

| Evidence                                                                                                                               | Location                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ctx.dep()` has **zero call sites**                                                                                                    | whole repo                                                                                                |
| `apiRouter` imported directly by four extensions                                                                                       | `persistency/index.ts:3`, `swagger/index.ts:3`, `tracingPersistency/index.ts:3`, `tracingRest/index.ts:3` |
| Four extensions mount at `use("/", …)`; `/api/cases` GET resolves to `persistencyRouter` only because `casesRouter` defines no `GET /` | mounting order                                                                                            |
| `tracingPersistency` subscribes to `Trace Persistence Request`, which **nothing emits**                                                | `tracingPersistency/index.ts:27`                                                                          |
| `Trace Completed` is declared, never emitted, never subscribed                                                                         | `tracingPersistency/index.ts:11`                                                                          |
| `api` has an empty `setup()` — a schema module wearing the extension interface                                                         | `api/index.ts`                                                                                            |
| NATS handler **drops `difficulty`**                                                                                                    | `nats/cases.handler.ts:38` destructures 5 fields; `:59` calls `generateCase(..., language)`               |
| NATS handler is **not awaited** in the consume loop                                                                                    | `nats/cases.handler.ts:181`                                                                               |

## Task

### 1. Delete

`src/extensions/persistency/`, `tracingPersistency/`, `tracingNats/`, `debugLogger/`, `swagger/`, plus `src/core/loader.ts`, `src/core/extension.ts`, `scripts/generate-registry.ts`, `src/extensions/_registry.ts`, and the `generate` step from the `dev`/`build` scripts.

`api/` becomes a plain schema module — move it to `src/api/` or fold it into the service layer; it is not an extension.

**Keep the `EventBus`.** It genuinely decouples tracing from the graph.

### 2. Composition root

`createApp()` constructs transports explicitly from resolved config:

```
COMM_REST=true   REST_PORT=3030
COMM_NATS=false  NATS_URL=…
```

### 3. `CaseGenerationService`

```ts
interface CaseGenerationService {
  generate(req: CaseGenerationRequest): Promise<CaseGenerationResult>;
  cancel(jobId: JobId): boolean;
}
```

It owns what both transports currently duplicate: ICD→name resolution, jobId minting, `runWithContext`, **terminal event emission**, and error→status mapping. Transports shrink to protocol translation.

**Return a job shape, not a bare case:**

```ts
type CaseGenerationResult = { jobId: string; status: "done" | "failed"; case?: Case; error?: … };
```

A synchronous transport still blocks on it. This costs nothing now and means human-in-the-loop (F01) can add `status: "awaiting_review"` as a new value instead of a breaking API change.

### 4. Fix the two NATS defects

- Pass `difficulty` through (`cases.handler.ts:38,59`). Once both transports call one service, this becomes impossible by construction — but fix the symptom too.
- `await consumeCaseGenerateMessage(msg)` at `cases.handler.ts:181`. Without it, `ack`/`nak` races the next iteration and generations pile up unbounded despite `max_messages: 1`.

### 5. Terminal events move to the service

`Generation Completed` / `Failure` / `Cancelled` are emitted by the transports today, so any other caller gets none of them. Move emission into the service.

### 6. Labels: English fallback only

Per design §8, delete LLM label translation entirely:

- the pre-warm block in `02graphs/caseGraph.ts:79-93`
- `resolveLabel`, `knownLabels`, `getKnownLabels` in `utils/nodeWrapper.ts`
- `03aigateway/labels.aigateway.ts`

Core emits **English labels**; the transport looks up a translation and falls back to English. Note the SSE path never forwarded `label` at all (`tracing/index.ts:33-35` forwards only `{node, timestamp}`) — fix that inconsistency while you are here.

### 7. Also delete

`RequestContext.language` (`utils/context.ts:14` — never populated); the inlined `PresentationSchema` and its comment (`03procedure/tools.ts:26-33` — the `zod`/`zod/v4` split is a subpath distinction _within_ v4, not a version mismatch, so the workaround addresses a non-problem); `getRequiredRequestContext`; `decodeObject`, `parseStructuredResponse`, `parseStructuredResponseAgent`, `getSearchTool` in `utils/llm.ts`.

## Behaviour change — release notes

Removed endpoints: `GET /api/cases` (persistency), `GET /api/traces`, `GET /api/traces/:jobId`, and Swagger UI. The last two never returned data. `GET /traces/:jobId/stream` survives.

## Acceptance criteria

- [ ] `src/core/loader.ts`, `src/core/extension.ts`, `_registry.ts`, `scripts/generate-registry.ts` are gone
- [ ] `pnpm dev` and `pnpm build` no longer run a registry generation step
- [ ] Both transports call `CaseGenerationService`; neither resolves ICD, mints a jobId or emits terminal events
- [ ] A NATS request with `difficulty: "hard"` produces a hard case
- [ ] Terminal events fire for a direct service call with no transport involved
- [ ] `grep -rn "labels.aigateway\|getKnownLabels\|resolveLabel" src/` returns nothing
- [ ] Trace events carry English labels; the transport localises
- [ ] SSE and NATS trace consumers receive the same fields

## Out of scope

Graph assembly from flags (08) — keep the single compiled graph here.
