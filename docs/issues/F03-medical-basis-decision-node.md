# F03 — Medical-basis decision node

**Status:** Future work · **Depends on:** 14
**Design ref:** `architecture-target.md` §6.3

## Summary

Issue 14 concatenates **all** medical-basis providers, spending no LLM call on selection at any registry size. If provider count, latency or cost ever makes that impractical, add a selection step **in front of** the concatenation.

## Why it is deferred

Concatenation is usually the better clinical answer — if a UMLS lookup and a PubMed lookup both have something to say, the plan is better for having both than for having whichever one a router picked. And a decide node on every request would reintroduce exactly the LLM cost the registry design set out to avoid.

## Design sketch — a ladder, not a router

The concatenation design is deliberately the degenerate case of this one, so the upgrade is additive:

| Tier | Condition | Cost |
|---|---|---|
| 0 | Registry empty → node not compiled in | zero |
| 1 | Providers declare a deterministic `appliesTo(query)` predicate (ICD prefix or chapter, difficulty, required request fields). Filter in code | zero LLM |
| 2 | Several applicable → **concatenate** (today's behaviour) | zero LLM |
| 3 | Only when a provider declares itself `exclusive` — expensive, rate-limited, or contradictory with a sibling → LLM tiebreak | 1 call, rare |

The important property: an LLM decision is entered only when more than one provider is *applicable* **and** at least one is exclusive — not merely because two are installed.

## Triggers for picking this up

- More than ~5 providers, where concatenation bloats the plan prompt enough to hurt a small model
- A paid or rate-limited provider that should not be called on every request
- Two providers that genuinely contradict each other, where merging produces an incoherent plan

## Notes

Adding `appliesTo` alone — tier 1, with no LLM at all — is worth doing before tier 3 and is a much smaller change. It may remove the need for a decision node entirely.
