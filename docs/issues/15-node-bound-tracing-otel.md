# 15 — Node-bound tracing and labels, on an OpenTelemetry standard

**Depends on:** 05, 08 · **Related:** 11, F09
**Design ref:** `architecture-target.md` §8 (labels), §3 (communication)

Split out of the 05 round as too large to fold in. Nothing here is a prerequisite for the
current stack; it wants its own PR.

## Why

Three things are tangled together today under the word "tracing":

1. **Labels** — short human-readable progress text (`"Generating case outline"`), localized, meant for a loading indicator an end user watches.
2. **Traces** — the structured record of what each node actually produced, meant for a developer or operator debugging a generation.
3. **Transport** — SSE streaming of both, over one untyped channel.

They have different audiences, different retention needs and different failure modes, but they travel as one `TraceEvent` with a `payload: any`. And neither is bound to the **graph structure**, so a client cannot render the pipeline and light up nodes as they run — it can only append lines to a log.

## Current state

| Fact                                                                                                                                                        | Location                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `createTraceNode` emits `Node Started` / `Node Completed` with `{node, label, result, jobId, timestamp}`                                                    | `utils/nodeWrapper.ts:36-71`        |
| **`traceNode` has no `try`/`catch`** — a throwing node emits `Node Started` and never `Node Completed`. Any consumer pairing them is permanently unbalanced | `utils/nodeWrapper.ts:58`           |
| `TraceEvent.payload` is `any`, with an eslint suppression                                                                                                   | `src/tracing/traceManager.ts:6-12`  |
| Per-job bus cleanup is a hardcoded `setTimeout(..., 10000)` "to ensure all events are sent"                                                                 | `src/tracing/traceManager.ts:42-49` |
| The graph structure exists only as a **build-time** mermaid artifact, via `getGraphAsync({ xray: true })`                                                   | `02graphs/exportGraphs.ts:65,84`    |
| Node names passed to `traceNode` are the LangGraph node ids — so events already carry a usable key; what is missing is the structure to hang them on        | throughout `02graphs/`              |
| Enabling tracing is `FEATURES=TRACING`, checked in `createApp()`                                                                                            | `core/app.ts:63`                    |

Note that `FEATURES=TRACING` already gates tracing the same way `REST` and `NATS` gate the
transports — the "enable/disable by env flag" part of this request is **already true**. What
is not uniform is the naming, which is entangled with the deferred `COMM_REST` / `COMM_NATS`
rename (see issue 05's PR notes).

## The distinction to make explicit

|             | Labels                                                                 | Traces                               |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------ |
| Audience    | end user                                                               | developer / operator                 |
| Content     | one short phrase per node                                              | the node's actual output             |
| Language    | localized at the transport (issue 05), English in core                 | English, never translated            |
| Cardinality | one per node, static, from a catalogue validated at startup (issue 02) | one per node **execution**           |
| Lifetime    | live only                                                              | live **and** exportable to a backend |
| Failure     | falls back to the English key; never fatal                             | must record the error, not go silent |

Both are **keyed by node id**. That is the unifying idea: a client fetches the graph
structure once, then receives node-keyed label and trace events it can overlay onto the
rendered graph.

## Task

### 1. Expose the compiled graph structure

`GET /api/graph` (name to be decided) returning nodes and edges of the **actually compiled**
graph, plus each node's English label key.

It must reflect the compiled topology, not a static description — after issue 08 the shape
varies with the deployer's flags, so a hardcoded diagram would be wrong for half of all
deployments. `getGraphAsync({ xray: true })` already provides this;
`02graphs/exportGraphs.ts` uses it to draw mermaid.

Include the label key per node so a client can localize it itself, or serve the localized
label per the request's language — decide which, and say why.

### 2. Node-bound event payloads

Give label and trace events a **typed** shape carrying a stable `nodeId` that matches the
structure endpoint. Kill `payload: any`.

Consider whether labels and traces should be two separate SSE event types rather than one
`type`-discriminated stream, given only one of them is meant for end users.

### 3. OpenTelemetry for the trace channel

Emit an OTel span per node from the same `traceNode` seam: span name = node id, attributes
for `jobId`, node output size, model/provider, token counts where available. Export via OTLP.

**Recommended split, not a foregone conclusion:** keep the `EventBus` as the _user-facing
progress_ channel and add OTel as a _parallel operator-facing_ channel from the same seam.
They are not the same thing — OTel is sampled, batched, and shipped to a backend on its own
schedule, which is wrong for a loading indicator; and an SSE stream scoped to one job is
wrong for cross-request performance analysis. Collapsing them into one mechanism is the
likely design mistake here, so it should be an explicit decision either way.

Adopting OTel also brings its **standard environment variables** (`OTEL_SDK_DISABLED`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`), which is most of what "rely on tracing
standards" buys: a deployer configures it the way they configure everything else, and points
it at whatever backend they already run.

### 4. Fix the two defects while you are in here

- **`traceNode` must `try`/`catch`**, emit a terminal event on failure, and end the span with
  an error status. Today a failed node silently stops the pairing.
- **Replace the 10-second cleanup timer** with something deterministic — the per-job bus
  should be torn down when the last consumer disconnects or the job reaches a terminal state,
  not on a guess.

### 5. Flag naming

Fold into the `COMM_REST` / `COMM_NATS` decision deferred in issue 05 rather than inventing a
third scheme. If OTel lands, `OTEL_SDK_DISABLED` arguably replaces the `TRACING` flag for the
trace channel, while labels stay on the communication layer's own flag — worth deciding
deliberately rather than ending up with both.

## Open questions

- Does the label channel survive at all once traces are node-bound and typed, or is a label
  just a trace event's `label` field? The catalogue and its startup validation (issue 02)
  argue for keeping labels a separate, closed, validated vocabulary.
- Should trace events carry the node's **full** output? Case outlines are large, and issue 11
  makes some node outputs binary. An OTel attribute limit will truncate them; the SSE channel
  will not. Probably: a size cap plus a reference, but that needs deciding.
- Interaction with F09 (checkpointing): a resumed run re-executes a node, so the same
  `nodeId` produces two spans for one logical step. Decide whether that is one span with
  retries or two.

## Acceptance criteria

- [ ] A client can fetch the compiled graph's structure at runtime and render it
- [ ] Label and trace events carry a `nodeId` that matches that structure
- [ ] `payload: any` is gone; the eslint suppression with it
- [ ] A node that throws produces a terminal event **and** an errored span
- [ ] Per-job resources are released deterministically, not on a timer
- [ ] With the SDK disabled, no OTel machinery is constructed (assert with a spy, as issue 04
      does for `TraceBus`)
- [ ] Traces are English; labels localize at the transport, falling back to English
- [ ] The structure endpoint reflects a flag-varied topology (test with two flag sets, after
      issue 08)

## Out of scope

Persisting traces (the Redis-backed version was deleted in issue 05 and never worked).
Replaying a trace. The `COMM_*` rename itself.
