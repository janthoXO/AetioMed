# Human-in-the-loop review of the plan

**Status:** Deferred · **Date:** 2026-09-02
**Relationship to other docs:** split out of `docs/architecture-target.md` so the target architecture stays focused. Nothing in the target architecture depends on this document, but §"Design now, build later" below lists the three cheap things to do *while* building the target architecture so that HITL is additive rather than a rewrite.

## Why this is deferred

Adding a human review gate to the plan stage is the single largest architectural change on the roadmap. It is not a feature bolted onto the graph; it changes the transport contract, job identity, cancellation, and process-lifetime assumptions all at once. Deferring it is the right call — provided the three items in the last section are done up front, because they are the ones that are cheap now and expensive later.

## What LangGraph 1.3.0 actually gives you

Verified against the installed package, because it constrains the option space more than expected:

| Fact | Consequence |
|---|---|
| `interrupt()` **throws unless a checkpointer is set** — `GraphValueError("No checkpointer set")` | **There is no checkpointer-free pause.** Every option below starts by adding one |
| **No checkpointer package is installed.** Only the in-memory `MemorySaver` ships with `@langchain/langgraph-checkpoint` | You must add `@langchain/langgraph-checkpoint-sqlite`, or write ~200 lines of `BaseCheckpointSaver` against the `node:sqlite` connection already in `03repo/db.ts` |
| `checkpointer: true` means "inherit from parent" and **throws on a root graph** | Checkpointing the root suffices — subgraphs inherit |
| Any invoke with a checkpointer **requires `configurable.thread_id`** | The natural `thread_id` is the existing `jobId` |
| Per-invoke `durability: "exit" \| "async" \| "sync"` | Pay for a synchronous checkpoint write only around the review node |

> "In-memory pause, no checkpointer" is not an available option. `MemorySaver` is the floor, not zero.

## The re-execution trap — where the interrupt must not go

A node **re-executes from the top on resume.** So `interrupt()` must *not* live inside `outlineEvaluate`, or the judge's LLM call is paid twice on every resume. The review must be its own side-effect-free node, placed between the accept branch and the presentation fan-out.

Second-order: `traceNode` (`utils/nodeWrapper.ts`) has no `try/catch`, so `GraphInterrupt` propagates cleanly — but **"Node Completed" is never emitted** for the interrupted attempt, and "Node Started" fires *again* on resume. Any trace consumer pairing started/completed is permanently unbalanced. Small fix, but make it deliberately.

## What breaks

1. **The REST contract.** `POST /api/cases` blocks, and `res.on("close")` calls `cancelManager.abort(jobId)`. A proxy timeout during review does not merely drop the response — **it aborts the generation.** Request/response cannot survive an unbounded pause:
   ```
   POST /api/cases               → 202 { jobId }
   GET  /api/cases/:jobId        → { status: running | awaiting_review | done | failed }
   POST /api/cases/:jobId/resume → { action, feedback? }
   GET  /traces/:jobId/stream    → already exists; carries the awaiting_review event
   ```
2. **NATS redelivers.** `ack_wait` is 10 minutes with no heartbeat. A longer pause triggers redelivery and a **duplicate generation**. Options: heartbeat `msg.working()` while paused (bounded reviews only); ack on interrupt and treat resume as a new message on `cases.resume.<jobId>` (correct for unbounded pauses); or **declare HITL a REST-only feature** — legitimate, but name it rather than discover it.
3. **Cancel stops working.** `cancelManager.abort` aborts an in-flight `AbortController`. A run paused at an interrupt has *nothing in flight*. Cancel becomes a state transition on a job record plus checkpoint deletion.
4. **`runWithContext`'s lifetime assumption breaks.** It unregisters the controller and schedules trace cleanup in `finally`. An interrupt makes `invoke` *settle*, so tracing tears down and the controller unregisters while the job is conceptually alive. One context becomes one **segment**; the job record outlives all segments.
5. **There is no job resource today.** `persistency` writes completed cases under `case:${Date.now()}-${uuid}` — **the jobId is not in the key**, so a case cannot be fetched by jobId at all.

## Security — do not checkpoint the API key

`llmConfig` flows through `RequestContext` and contains a per-request `apiKey` (`models/LLMConfig.ts:6`). A naive "checkpoint everything" persists caller API keys to disk in a server third parties deploy. **Require the resume caller to re-supply `llmConfig`**, and validate that provider and model match the original. The same applies to language-bound ports (`architecture-target.md` §5): rebuild them on resume, never persist them.

## Options

| | Approach | Survives restart? | Cost |
|---|---|---|---|
| A | `MemorySaver` + resume registry, keep POST-and-block | No | You still need resume routing, so you pay half of B anyway. Buys days, not architecture |
| B | **SQLite checkpointer + async job resource, single process owner** | Yes | Medium. The standard answer |
| C | Postgres checkpointer, NATS resume subject, stateless workers with leasing | Yes | Makes Postgres a requirement for HITL deployers — fights the embedded-SQLite ethos |

**Recommend B** when the time comes, designed so C stays reachable. B also independently delivers the crash resumption `engineering-review.md` §3.6 asks for — a 20-LLM-call pipeline currently loses everything on a crash. Its one real constraint is **single writer**: two replicas resuming the same `thread_id` will conflict, so either document "one process per DB" or go to C.

## Approve/reject versus free editing

The plan is a bare markdown string (`case.aigateway.ts` returns `result.text`). That forces a choice nobody has made:

| | Semantics | Cost | Consequence |
|---|---|---|---|
| A | **Approve / reject with feedback** | Low — reuses the existing evaluate⇄revise loop verbatim | The human simply replaces or precedes the LLM judge |
| B | Free editing of the plan text | High | Edited text re-enters the pipeline unvalidated; you lose the guarantee that downstream fields render only facts the judge saw |

**Recommend A.** B is a separate decision, and if it is ever wanted it should re-run the judge over the edited plan rather than trusting it.

## Design now, build later

Three things belong in the target architecture work even though HITL is deferred. Each is cheap now and expensive to retrofit:

1. **Make the service return a job, not a case.** `generate(req) → { jobId, status, case? }`. A synchronous transport can still block on it. When HITL lands, `status: "awaiting_review"` becomes a legal value instead of a breaking API change.
2. **Type the decision now**, even with no producer:
   ```ts
   type ReviewDecision =
     | { action: "approve" }
     | { action: "revise"; feedback: string[] }
     | { action: "reject" };
   ```
   `revise` maps *exactly* onto the existing `outlineFeedback` channel and `outline_regenerate` node. Make `ReviewDecision` and `OutlineEvaluationSchema` the **same shape**, and HITL becomes "a human replaces or precedes the LLM judge" rather than a new mechanism. About twenty lines today.
3. **Keep the plan stage independently invocable.** `planGraph` as its own subgraph with its own state schema (`architecture-target.md` §6.1) is what makes a review gate insertable without touching generation.
