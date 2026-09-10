# 17 — Transport parity: asymmetric REST/NATS split, partial NATS backbone, labels out of tracing

**Depends on:** 15 · **Related:** 05, 09, F09
**Design ref:** `architecture-target.md` §3 (communication), §8 (labels)

Two transports exist (`REST`, `NATS`) and neither can serve a client on its own. This issue
makes every **product** feature reachable from both, keeps the **delivery guarantees**
deliberately asymmetric, and — as a consequence that falls out of the first two — separates
labels from tracing into two modules with different gates, different audiences and different
directories.

## Why

The stated requirement is: _a client speaking only NATS, or only REST, has every feature._
Today that is false in both directions, and the gaps are not a design — they are drift. Labels
live in `src/tracing/`, `src/tracing/` grew an SSE **adapter** and never grew a NATS one, so a
NATS client has no progress channel at all. Nothing decided that; nobody wrote the second
adapter.

The **seam** that should have prevented this already exists. `CaseGenerationService`
(`src/core/caseGenerationService.ts`) is the single entry point both transports call, and
`CLAUDE.md` states transports are protocol translation only. Under that rule parity is the
_default_ and asymmetry is what needs justification. A feature reachable from exactly one
adapter means the feature leaked out of core into that adapter — which is precisely what
happened to labels.

## Current state

| Fact                                                                                                                                                      | Location                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| REST mints a jobId server-side, or reads it from an undocumented `?jobId=` query param                                                                    | `rest/routes/cases.router.ts:32`   |
| REST cancels the generation on **any** socket close — user intent and network fault are indistinguishable                                                 | `rest/routes/cases.router.ts:35`   |
| The `cases` JetStream stream captures `cases.>` with `retention: workqueue`                                                                               | `nats/cases.handler.ts:113-114`    |
| …so `cases.generated` and client-published `cases.cancel.*` are persisted into a workqueue stream **with no consumer**, and workqueue only deletes on ack | `nats/cases.publisher.ts:5`, `:82` |
| …and a result on a workqueue stream is single-delivery and stealable: the first consumer to ack destroys it for everyone else                             | `nats/cases.publisher.ts:5`        |
| NATS runs exactly one generation at a time deployment-wide; REST is unbounded                                                                             | `nats/cases.handler.ts:137`        |
| NATS cancel is fire-and-forget with no reply; REST's `DELETE` answers 204/404                                                                             | `nats/cases.handler.ts:82-95`      |
| NATS has no label channel, no trace channel, no graph structure, no diagnosis/procedures/features/allowedLlms                                             | `nats/` (absent)                   |
| The per-job bus registry is an in-process `Map`                                                                                                           | `tracing/traceManager.ts:106`      |
| An unknown jobId on the SSE route answers `event: complete` — "wrong process" is indistinguishable from "job finished"                                    | `tracing/sse/router.ts:17-18`      |
| `registerJobHook` is a **single slot** (`let jobHook`), last registration wins                                                                            | `graph/utils/context.ts:65`        |
| Labels and traces share one gate, `FEATURES=TRACING`                                                                                                      | `core/app.ts:70-71`                |
| Trace payloads are capped at 50 KB                                                                                                                        | `tracing/tracePayload.ts:23`       |

## Decisions

### D1 — Job lifetime is per-transport, on purpose

REST is the **synchronous** transport: a job lives as long as its HTTP connection. NATS is the
**asynchronous** transport: a job outlives every connection, and JetStream provides the
durability. No application-level result store is built. This is the decision that keeps the
whole design small — see §"Rejected alternatives".

### D2 — Asymmetry is allowed in delivery guarantees, never in features

Every product feature — submit, labels, result, cancel, catalogue reads, graph structure — is
reachable from both transports. What differs is only what the protocol itself can promise:

|                              | REST                              | NATS                                   |
| ---------------------------- | --------------------------------- | -------------------------------------- |
| Submit                       | `POST /api/cases`                 | `cases.request.generate`               |
| Labels                       | SSE on the POST, and `GET` stream | `cases.progress.<jobId>.label`         |
| Result                       | final SSE frame / JSON body       | `cases.result.<jobId>`                 |
| Cancel                       | `DELETE /api/cases/:jobId`        | `cases.cancel.<jobId>` (request/reply) |
| Catalogues, features, graph  | `GET /api/*`                      | request/reply endpoints                |
| **Redelivery after a drop**  | **no**                            | **yes**                                |
| **Result recoverable later** | **no**                            | **yes** (stream `max_age`)             |

The last two rows are the sanctioned asymmetry. Nobody expects HTTP to redeliver after a
dropped socket; that is a property of the transport, not a feature of the product.

### D3 — REST POST is a stream, and the jobId arrives as its first frame

```
POST /api/cases
  Accept: application/json     → blocks, returns the case (today's behaviour, kept)
  Accept: text/event-stream    → SSE on the POST's own response:
      event: accepted   {"jobId": "..."}      ← before any node runs
      event: label      …
      event: result     {case…}   |   event: error
```

This removes the id-handshake question entirely. A 202-then-subscribe design loses every event
between accept and subscribe; a stream opened by the request itself cannot race, because it
exists before `generateCase` is invoked.

The client **may** supply its own `jobId` in the body (validated UUID). The server mints one
when it is omitted, and **dedupes on it**: a retry after a dropped connection must attach to or
be rejected by the running job, never start a second generation. Move the existing
`?jobId=` query param (`cases.router.ts:32`) into the body as part of this.

### D4 — REST can watch a job NATS started

The per-job event channel becomes **core-owned**, and both transports are adapters onto it. A
NATS-submitted job publishes to the same in-process channel a REST-submitted one does, so:

- `GET /api/cases/:jobId/labels` (SSE) streams labels for **any** active job, whatever
  submitted it.
- `DELETE /api/cases/:jobId` cancels **any** active job, whatever submitted it.

A REST observer can _watch_ a NATS job but cannot _collect_ it: the result goes to
`cases.result.<jobId>`, and the observer stream carries labels plus a terminal marker without
the case. An observer is not the requester. Requesting the result of a NATS job over REST is
asking for the result store D1 declined to build.

### D5 — Partial NATS backbone: REST rides NATS when both are enabled

D4 works in one process and silently breaks in two: `tracing/traceManager.ts:106` is an
in-memory `Map`, so a `GET` landing on replica A cannot see a job running on replica B, and
`tracing/sse/router.ts:17-18` reports that as `event: complete` — a **silent wrong answer**.

So, when `FEATURES` contains both `REST` and `NATS`:

- the REST label stream subscribes to `cases.progress.<jobId>.>` instead of the local channel;
- REST `DELETE` **publishes** `cases.cancel.<jobId>` instead of calling `cancelManager.abort()`
  directly. The existing core-NATS cancel broadcast (`nats/cases.handler.ts:82`) already does
  the right thing across processes: every replica receives it, each checks its local
  `cancelManager`, whichever owns the job aborts. REST's direct call is the one that only works
  by accident of co-location.

With `NATS` disabled, both fall back to the in-process channel and single-replica is a
documented deployment constraint. NATS is **infrastructure here, not a feature** — this is the
only place the two transports are not peers.

Note the direction: REST depends on NATS, never the reverse. NATS must not gain a dependency on
the REST module.

### D6 — NATS subject and stream layout

Split on **durability requirement**, not on feature. A JetStream stream's retention applies to
everything its subject filter captures, which is exactly the bug in `cases.handler.ts:113-114`.

```
JetStream  CASE_REQUESTS   subjects: cases.request.*    retention: workqueue
    cases.request.generate         durable pull consumer, ack_wait ≈ max generation time

JetStream  CASE_RESULTS    subjects: cases.result.*     retention: limits, max_age ~1h
    cases.result.<jobId>           per-job subject: a client filters to its own result,
                                   with replay — this is what makes D1's "no store" true

Core NATS, no JetStream (ephemeral):
    cases.progress.<jobId>.label   fan-out
    cases.progress.<jobId>.trace   fan-out (only while §4's dev channel exists)

Core NATS request/reply:
    cases.cancel.<jobId>           → { cancelled: boolean }
    catalog.diagnosis, catalog.procedures, meta.features, meta.allowedLlms, meta.graph
```

Four channels, **two** streams. A second stream exists only because retention differs. Subject
prefixes must not overlap, or a stream captures another channel's traffic.

`retention: limits` on results is load-bearing: on `workqueue` the result is deleted by the
first ack and JetStream refuses overlapping consumers, so "NATS provides the persistence" is
simply false. `label` and `trace` are separate subject tokens rather than one subject with a
`kind` field, for the same reason `sse/router.ts` writes separate `event:` types — a progress UI
should never have to filter operator payloads out of its own handler.

Concurrency (`max_messages: 1`, `cases.handler.ts:137`) becomes a shared
`MAX_CONCURRENT_GENERATIONS` applied to both transports, so throughput does not depend on which
door a request came in.

### D7 — Labels and tracing are two modules, not one

This is the consequence of D2 and D4. Once labels are a product feature of the streaming API
rather than telemetry, they cannot stay behind a telemetry flag, and they cannot stay in a
directory named after the other concern.

|            | **Labels**                                      | **Tracing**                                     |
| ---------- | ----------------------------------------------- | ----------------------------------------------- |
| Audience   | end user                                        | operator                                        |
| Emitted on | node **started** and node **terminal**          | node started **and** finished, with node output |
| Content    | one short localized phrase, **never a payload** | node output, size-capped                        |
| Transport  | SSE **and** NATS                                | OTLP only                                       |
| Gate       | **none — always on**                            | `OTEL_SDK_DISABLED` (standard OTel axis)        |
| Lives in   | `src/core/jobEvents/`                           | `src/observability/`                            |

**The axis of the split is payload, not event count.** Both channels see every node start and
every node terminal. Labels carry a localized phrase and a `started | completed | failed`
status; tracing carries the same lifecycle _plus_ the node's output. Neither channel is a
subset of the other's events, so a consumer of one is never forced to also consume the other to
reconstruct what happened — they are not additive, they are two complete views at different
detail levels.

That is why labels keep a terminal status. Dropping it would have made the label channel
depend on the trace channel for completion, which is exactly the additivity this split exists
to avoid — and it does not survive this graph's shape (see §"Concerns" 1).

Directory split:

```
src/core/jobEvents/          per-job channel, LabelEvent, localization, node-label registry
src/observability/           OTel SDK adapter, NodeTracer/NodeSpan implementation, payload cap
src/transports/rest/…        SSE writer   (moves out of src/tracing/sse/)
src/transports/nats/…        NATS label publisher (new)
```

The **deletion test** on the old `src/tracing/` module: deleting it concentrates nothing,
because it was three unrelated things sharing a gate — a per-job pub/sub channel, a
localization step, and an OTel adapter. Splitting it gives each a single reason to change.

Two pieces must move with **labels**, not with tracing:

- the node-label registry (`getKnownLabels`/`getNodeLabels`, `utils/nodeWrapper.ts:62-82`) —
  `catalog/startupValidation.ts` uses it as the labels catalogue's base key set;
- `GET /api/graph` (`tracing/structure/`) — a client that receives labels but cannot fetch the
  topology to render them on has half a feature. It follows labels' always-on gate.

`FEATURES=TRACING` is then **deleted**. With tracing gated by `OTEL_SDK_DISABLED` and labels
always on, it gates nothing. Two flags for one axis is how the current tangle started.

## Concerns with D7

### Why labels keep a terminal status — resolved, recorded

The first draft of D7 had labels fire on node **start only**. That was amended; this records
why, so it is not re-proposed. Dropping everything but `started` costs three things:

- **Failure becomes invisible.** A node that throws currently emits a `failed` label. Without
  it, a crashed generation is indistinguishable from a slow one: the UI sits on a spinner
  forever. `traceNode`'s `try`/`catch` (`nodeWrapper.ts:242`) was added by issue 15 specifically
  so a consumer pairing started/terminal events is never left unbalanced — this reintroduces the
  imbalance on the user-facing channel.
- **The last node never completes.** The final node shows as in-progress until the result
  arrives on a different channel.
- **"Next start implies previous finished" is false here.** That inference works on a linear
  chain. This graph is not one: `buildFieldGenerationSends` fans out `patient` /
  `chief_complaint` / `anamnesis` in parallel, and the blinded-solver loop revisits the same
  nodes up to 6 times. Parallel fan-out and loops are exactly where a progress UI needs
  completion signals most.

The distinction actually wanted is **payload**, not **event count**: labels keep `started` and
one terminal status, and only the node _output_ moves to tracing. Folded into D7.

## OpenTelemetry: what the pieces are, and which ones this issue uses

D7 makes OTLP the only export path for tracing. That is a bigger commitment than it looks,
because "send it to OTel" is not one thing — OTel is three independent **signals**, each with
its own SDK object, its own exporter, its own wire message and its own storage on the backend.
Picking the wrong one is how node output ends up silently truncated.

### The three signals

| Signal      | Wire message | What it is                                                                     | Use it for                                 |
| ----------- | ------------ | ------------------------------------------------------------------------------ | ------------------------------------------ |
| **Traces**  | `Span`       | One timed operation: name, start/end, status, parent link, attributes, events  | The shape and timing of a generation       |
| **Metrics** | `Metric`     | Aggregated numbers: counters, gauges, histograms                               | Node duration percentiles, generations/min |
| **Logs**    | `LogRecord`  | A timestamped record: severity, **body**, attributes, correlated by `trace_id` | The node's actual output                   |

They travel over the same OTLP protocol to the same endpoint, but as different message types
into different backend stores. A backend indexes spans for search and stores log bodies as
bulk text — which is exactly the distinction that matters here.

### Inside a span, there are three places to put data

- **Span attributes** — key/value pairs on the span. These are the **dimensions you filter and
  group by**: `jobId`, `nodeId`, provider, model, output _size_. Backends index every one, so
  they are optimised for many small values, not few large ones. This is what `CLAUDE.md`'s
  existing rule means by _"span attributes only, never payload"_.
- **Span events** — timestamped annotations _inside_ a span, each with their own attributes.
  The OTel convention records exceptions this way. Useful for "something notable happened at
  time T", but they ship attached to the span, so they inherit the same size pressure.
- **Span links** — references to other spans. Not used here.

### Why the node output is a log record, not an attribute

Three independent reasons, any one of which is sufficient:

1. **Size.** `tracing/tracePayload.ts:23` caps payloads at 50 KB. The OTel _spec_ leaves
   attribute value length unlimited by default (`OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`), but
   backends do not: Jaeger, Tempo, Datadog and Honeycomb all cap attribute values in the low
   kilobytes and truncate or drop past it. Case outlines are large markdown. They will not
   survive the trip, and the failure is silent.
2. **Cost and cardinality.** Most vendors bill on span and attribute volume. A 50 KB attribute
   on every node of every generation is a bad line item for data nobody queries _by_.
3. **It is what was actually asked for.** The phrasing driving D7 — _"when a node finished its
   **log message** with the output of the node"_ — describes a log record. OTel's logs signal
   is built for exactly this: a body of arbitrary size, correlated to its span by `trace_id`
   and `span_id`, so a backend shows the log inline on the span's timeline anyway.

**Decision:** span per node carrying attributes only (`nodeId`, `jobId`, output _size_,
provider/model, status); node output emitted as a correlated **log record** on span end.
`CLAUDE.md`'s tracing table is amended by this issue, not contradicted by accident.

### "Tracing must also show the node starting" — it does, with one caveat

A span _is_ the started-and-finished pair: it carries `startTime` and `endTime` in one message.
So a trace consumer always knows when a node started, and never needs the label channel to
reconstruct it — which is the non-additivity D7 requires.

The caveat is **liveness, not completeness**: OTel has no "span started" wire event. A span is
serialised and exported once, on `end()`. A consumer watching a running generation sees nothing
for a node until that node finishes. For OTLP's audience — post-hoc analysis, cross-request
comparison — that is fine and is how every OTel backend works. It is only a problem for
watching a generation live, which is the label channel's job.

If live node-start visibility on the operator channel is ever genuinely needed, the OTel-native
answer is a log record at node start (logs export independently of span lifetime), not a span.
Not in scope here.

### Exporters and processors: why a console exporter is not optional

An **exporter** is where finished spans go; a **processor** decides when they go there.

| Combination                                   | Latency to visibility        | Infrastructure needed       | Use               |
| --------------------------------------------- | ---------------------------- | --------------------------- | ----------------- |
| `BatchSpanProcessor` + `OTLPTraceExporter`    | ~5s batch delay, then render | Collector **and** a backend | Production        |
| `SimpleSpanProcessor` + `ConsoleSpanExporter` | Immediate, to stdout         | **None**                    | Local development |
| `InMemorySpanExporter`                        | Immediate, in-process        | None                        | Tests             |

This is the answer to "why do I need a console exporter". Today, reading a node's output during
development costs nothing: open the SSE stream and watch `event: trace`. After D7, with OTLP as
the only path, the same task requires standing up an OTLP collector _and_ a trace backend
(Jaeger, Tempo, …) in compose, and waiting on a batch flush, before you can read one prompt.
`ConsoleSpanExporter` restores the zero-infrastructure path — it prints each span as JSON to
stdout — and `SimpleSpanProcessor` makes it appear as it happens rather than in 5-second
clumps. Neither is production-appropriate: console output is unqueryable and
`SimpleSpanProcessor` exports on the hot path.

**Decision:** select the exporter from existing env, no new flag —
`OTEL_EXPORTER_OTLP_ENDPOINT` set → batch + OTLP; unset with `FEATURES=DEBUG` → simple +
console; otherwise no SDK at all (`OTEL_SDK_DISABLED`, and `tracing/otel.ts`'s existing guarded
dynamic `import()` already means the SDK is never even loaded). `InMemorySpanExporter` is what
makes the span assertions in §"Acceptance criteria" testable without a backend.

### The collector, and why you probably want one

An OTel **Collector** (`otelcol`) is an optional process between the app and the backend: it
receives OTLP, transforms, and re-exports. Two things it is worth having here:

- **Redaction.** Node output is synthetic patient text, but it is patient-_shaped_. A collector
  processor is the right place to drop or scrub it before it reaches a third-party backend —
  and it is configuration, not a code change, so the policy can differ per deployment.
- **Cost control.** Sampling and attribute-dropping live there, so the app never has to know
  which backend is expensive.

Not required to ship this issue. Worth a compose profile alongside the existing `NATS` one.

## D8 — Resolved concerns, carried over from the transport design

- **The POST stream gets its own heartbeat.** _Decided: in scope, 17.5._ Holding the connection
  open must not depend on label cadence: labels fire on node boundaries, and one node (outline
  generation on a local model, one solver iteration) can sit silent for minutes, which is long
  enough for a proxy to close an idle connection. Emit an SSE comment frame (`: ping`) every
  15–20s independently of labels. Liveness and telemetry are separate concerns that happen to
  coincide today; they must not be coupled.
- **`registerJobHook`: core owns the channel, adapters subscribe.** _Decided: in scope, 17.1._
  `context.ts:65` is a single slot (`let jobHook`, last-writer-wins) and two adapters need to
  attach. Rejected: growing it into a list of hooks — that keeps core pushing into adapters it
  should not know about. Core owns the channel in `src/core/jobEvents/` and exposes
  subscribe/unsubscribe; adapters attach themselves. Same inversion `NodeTracer`/`NodeSpan`
  already uses for OTel.
- **Disconnect ≠ cancel is an accepted trade, not an oversight.** D1 keeps
  `cases.router.ts:35`'s behaviour for the streaming path. It is acceptable while a lost
  generation costs minutes and tokens rather than money, and clients are on stable networks. It
  stops being acceptable if either changes — at which point D1 flips and the result store in
  §"Future work" is the migration.

## Implementation split

Tracked as a stacked PR chain. Each issue is independently reviewable; each PR targets the one
below it.

| Stack | Issue                                                                                                    | Depends on | Covers         |
| ----- | -------------------------------------------------------------------------------------------------------- | ---------- | -------------- |
| 1     | [#139 Core owns the per-job event channel](https://github.com/janthoXO/AetioMed/issues/139)              | #116       | D4, D8         |
| 2     | [#140 Split labels from tracing; labels always on](https://github.com/janthoXO/AetioMed/issues/140)      | #139       | D7             |
| 3     | [#141 OTel: attribute-only spans, output as log record](https://github.com/janthoXO/AetioMed/issues/141) | #140       | §OpenTelemetry |
| 4     | [#142 NATS streams and subjects](https://github.com/janthoXO/AetioMed/issues/142)                        | —          | D6             |
| 5     | [#143 REST POST as a stream](https://github.com/janthoXO/AetioMed/issues/143)                            | #139       | D1, D3, D8     |
| 6     | [#144 NATS parity: labels and request/reply](https://github.com/janthoXO/AetioMed/issues/144)            | #139, #142 | D2             |
| 7     | [#145 Partial NATS backbone](https://github.com/janthoXO/AetioMed/issues/145)                            | #144       | D4, D5         |

#142 is independent of #139–#141 and can be merged on its own; it sits in the chain only to keep
one linear stack.

Future work: [#146 Replay buffer for the label stream](https://github.com/janthoXO/AetioMed/issues/146),
[#147 OTel collector deployment profile](https://github.com/janthoXO/AetioMed/issues/147). The
result store and cross-transport result collection stay recorded in §"Future work" below without
their own issues — they only become real if D1's trade stops holding.

## Public contract changes

These need release notes.

- `POST /api/cases` gains SSE content negotiation and a body-level `jobId`; `?jobId=` is removed.
- `GET /api/traces/:jobId/stream` is replaced by `GET /api/cases/:jobId/labels`; the trace half
  of that stream is removed — node output moves to the OTel logs signal.
- `GET /api/graph` is no longer gated by `FEATURES=TRACING`.
- `FEATURES=TRACING` is removed.
- OTel exporter selection follows existing env: `OTEL_EXPORTER_OTLP_ENDPOINT` set → batch +
  OTLP; unset with `FEATURES=DEBUG` → simple + console; `OTEL_SDK_DISABLED` → no SDK loaded.
  No new flag.
- `CLAUDE.md`'s tracing table is amended: node output now travels as an OTel **log record**
  correlated by `trace_id`, alongside the existing "span attributes only, never payload" rule
  for spans.
- NATS subjects are renamed: `cases.generate` → `cases.request.generate`, `cases.generated` →
  `cases.result.<jobId>`, `cases.cancel.>` gains a reply.
- The `cases` JetStream stream is replaced by `CASE_REQUESTS` and `CASE_RESULTS`. Existing
  deployments must delete the old stream — it cannot be reconfigured in place across a retention
  change.
- New env var: `MAX_CONCURRENT_GENERATIONS`.

## Acceptance criteria

- [ ] A test asserts a job submitted over NATS emits labels observable through the REST label
      stream, and vice versa.
- [ ] A test asserts `DELETE /api/cases/:jobId` cancels a NATS-submitted job.
- [ ] A test asserts the REST label stream subscribes over NATS when both flags are set, and
      over the in-process channel when only `REST` is set.
- [ ] A test asserts an unknown jobId answers 404, and a terminal jobId answers `complete` —
      the two are no longer conflated (`sse/router.ts:17-18`).
- [ ] A test asserts a duplicate `jobId` on `POST /api/cases` does not start a second
      generation.
- [ ] A test asserts `CASE_RESULTS` uses `limits` retention, and that two independent consumers
      can each read the same result.
- [ ] A test asserts no stream's subject filter captures another channel's subjects.
- [ ] A test asserts the POST stream emits a heartbeat frame with no label activity.
- [ ] A test asserts every node emits both a `started` and a terminal label, including a node
      that throws, and including nodes reached by parallel `Send` fan-out and by a solver-loop
      revisit.
- [ ] A test using `InMemorySpanExporter` asserts each node's span carries `nodeId`, `jobId` and
      an output **size** attribute, and that no span attribute carries the node's output text.
- [ ] A test asserts the node output is emitted as a log record correlated to its span's
      `trace_id`/`span_id`.
- [ ] A test asserts exporter selection: OTLP endpoint set → OTLP; unset with `DEBUG` → console;
      `OTEL_SDK_DISABLED` → the `@opentelemetry/*` dynamic `import()` never fires (extends
      `tracing/otel.test.ts`).
- [ ] `grep -r "FEATURES.*TRACING" src` returns nothing.
- [ ] `src/tracing/` no longer exists; no module under `src/core/` imports `@opentelemetry/*`.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint` pass; `npx prettier --write docs/issues/17-transport-parity.md`.

## Future work

- **Replay buffer for the label stream.** An observer attaching to an in-flight job has missed
  everything before it subscribed — a blank progress UI until the next node boundary, which can
  be minutes. Keep a small per-job ring of label events (tiny: `nodeId`, `status`, `label`,
  `timestamp`; ~50–80 per generation) and flush it on subscribe. Deliberately **not** in scope
  here: it is an ephemeral in-memory buffer with the job's lifetime, not the result store D1
  declined, but it is the first thing that starts to look like one and deserves its own
  decision. Pairs naturally with SSE `id:` + `Last-Event-ID` for spec-native reconnect.
- **Result store with TTL**, if D1's trade ever stops holding. One Drizzle table beside the
  existing caches; flips REST to a detached job resource and makes `GET /api/cases/:jobId`
  meaningful.
- **NATS as the full backbone**, if multi-replica REST is ever needed without `NATS` also being
  the submission path.
- **Cross-transport result collection**, which is the same thing as the result store.

## Rejected alternatives

- **Make both transports durable job resources** (202 + poll + store). Full symmetry including
  redelivery, but requires the result store, a TTL policy, and turns every REST client into a
  poller. Rejected as too large for the benefit while D1's trade holds.
- **Make both connection-scoped** (NATS drops JetStream, uses request/reply). Symmetric and
  storeless, but throws away NATS's only real advantage and a multi-minute generation blows any
  sane reply timeout.
- **202 + separate subscribe on REST.** Loses every event between accept and subscribe unless a
  replay buffer exists — which is the thing deferred to future work. D3's first-frame jobId has
  the same ergonomics with no buffer.
- **One SSE stream with a `type` discriminant** instead of separate `event:` types. Already
  rejected in issue 15 §3 for the audience reason; nothing here changes it.
- **Keep labels under `FEATURES=TRACING`.** Would make the primary REST endpoint degrade to a
  slow way of returning JSON when the flag is off.
