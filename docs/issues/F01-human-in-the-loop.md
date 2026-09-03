# F01 — Human-in-the-loop review of the plan

**Status:** Future work · **Full design:** `docs/human-in-the-loop.md`
**Depends on:** F09 (checkpointing), issue 05 (job-shaped service)

## Summary

A reviewer approves, revises or rejects the generated plan before presentation and procedure generation run.

This is the largest single change on the roadmap and has its own document. Read `docs/human-in-the-loop.md` before starting — it covers the LangGraph mechanics (verified against the installed version), the re-execution trap, the transport and NATS consequences, and the security constraint on checkpointing API keys.

## Why it is deferred

`interrupt()` **requires a checkpointer**, and none is installed. Beyond that, an unbounded pause breaks the REST contract (a proxy timeout does not merely drop the response — `res.on("close")` **aborts the generation**), causes NATS redelivery past `ack_wait`, and breaks `cancelManager`, which has nothing in flight to abort.

## Preserved by the implementation issues

Three things are being done up front so this remains additive rather than a rewrite:

| Preserved by | What |
|---|---|
| Issue 05 | `CaseGenerationService` returns a job shape, so `status: "awaiting_review"` is a new value, not a breaking change |
| Issue 08 | `planGraph` is an independently invocable subgraph, so a gate can be inserted without touching generation |
| *this issue* | The `ReviewDecision` type below, which should be added even before HITL ships |

```ts
type ReviewDecision =
  | { action: "approve" }
  | { action: "revise"; feedback: string[] }
  | { action: "reject" };
```

`revise` maps exactly onto the existing `outlineFeedback` channel and `outline_regenerate` node. Make `ReviewDecision` and `OutlineEvaluationSchema` the **same shape** and HITL becomes "a human replaces or precedes the LLM judge" rather than a new mechanism — about twenty lines.
