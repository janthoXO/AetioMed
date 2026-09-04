# F09 — Checkpointing and crash resumption

**Status:** Future work · **Depends on:** 05 · **Blocks:** F01
**Design ref:** `docs/human-in-the-loop.md`; `engineering-review.md` §3.6

## Summary

Persist graph state so a generation survives a crash, a deploy or a container reschedule — and so human-in-the-loop becomes possible at all.

## Why it is worth doing independently of HITL

A full generation is roughly **20+ LLM calls**, and on a local model that is minutes of work. Today a crash at call 19 loses all of it. Resumption is valuable on its own; HITL merely makes it mandatory.

## What the installed LangGraph gives you

Verified against `@langchain/langgraph` 1.3.0:

| Fact                                                                          | Consequence                                                                                                                                               |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interrupt()` **throws without a checkpointer**                               | There is no checkpointer-free pause; this issue is a hard prerequisite for F01                                                                            |
| **No checkpointer package is installed** — only in-memory `MemorySaver` ships | Add `@langchain/langgraph-checkpoint-sqlite`, or write ~200 lines of `BaseCheckpointSaver` against the `node:sqlite` connection already in `03repo/db.ts` |
| `checkpointer: true` means "inherit from parent" and throws on a root graph   | Checkpointing the root suffices — subgraphs inherit                                                                                                       |
| Any invoke with a checkpointer requires `configurable.thread_id`              | Use the existing `jobId`                                                                                                                                  |
| Per-invoke `durability: "exit" \| "async" \| "sync"`                          | Pay for synchronous writes only where it matters                                                                                                          |

## Design sketch

1. Add a SQLite checkpointer against the existing Drizzle-managed database, so no new infrastructure is required.
2. `thread_id = jobId`.
3. `durability: "async"` for ordinary nodes; `"sync"` around anything that must not be replayed.
4. Add a job record — `jobId`, `thread_id`, status, timestamps, request payload — in SQLite. Note the current Redis key omits `jobId` entirely (`case:${Date.now()}-${uuid}`), so a case cannot be fetched by jobId today.
5. Resume on startup, or expose a resume endpoint.

## Constraints to respect

- **Do not checkpoint the API key.** `llmConfig` carries a per-request `apiKey` (`models/LLMConfig.ts:6`). Persisting it writes caller credentials to disk in a server third parties deploy. Require the resume caller to re-supply `llmConfig` and validate that provider and model match the original.
- **Ports are not serialisable.** Language-bound ports live in `AsyncLocalStorage` (issue 09) and must be rebuilt on resume from the job record — the same problem as `llmConfig`, solved once.
- **Single writer.** Two replicas resuming the same `thread_id` will conflict. Either document "one process per database" or move to an external checkpointer.
- **Nodes re-execute from the top on resume.** Any node with a side effect must be idempotent, or the side effect must move to its own node.

## Notes

`getStateHistory` becomes available as a by-product, which is disproportionately useful for debugging a pipeline with this many LLM calls and — currently — no test suite.
