# 08 — Graph assembly from flags

**Depends on:** 05, 07 · **Blocks:** 09
**Design ref:** `architecture-target.md` §4.2

## Why

The graph is compiled once at module load with the translation sandwich as two conditional edges on `state.language`. Turning it off is a source edit, and `pnpm graph:export` can only ever draw the one compiled shape — so the SVGs in `docs/` document one configuration out of four.

## Current state

- `02graphs/caseGraph.ts:29-54` — `export const caseGraph = new StateGraph(...).compile()` at module load, with conditional edges at `:34-42` and `:44-52`
- `02graphs/02case-generation/index.ts:23-28` — conditional edge on the `procedures` generation flag
- `02graphs/exportGraphs.ts` — imports the single compiled `caseGraph`

## Task

### 1. `assembleCaseGraph(runtime, flags)`

Returns a compiled graph. **Absent flag ⇒ absent node** — not a skipped node, not a conditional edge. With `TRANSLATION_SANDWICH=false` the translation nodes are never added.

### 2. Build all four eagerly at boot

```
1. none
2. procedure-preselection
3. translation-sandwich
4. translation-sandwich+procedure-preselection
```

**Eager, not lazy.** Repos sync YAML at import time and validation can `process.exit(1)`; lazy compilation would move a possible process exit from boot to the first request needing that variant. Compilation itself is pure wiring — no I/O — so building four is cheap.

### 3. The compile-vs-branch boundary

Write this rule into the module doc comment, because the next person will get it wrong:

> **Compile on what the deployer chose; branch on what the caller asked for.**

`TRANSLATION_SANDWICH` and `PROCEDURE_PRESELECTION` are deployment config → compiled away. `generationFlags`, `difficulty` and `language` are per-request → stay in the request body and drive runtime branching. The conditional edge on the `procedures` generation flag **stays** a conditional edge.

### 4. Replace the const export

`export const caseGraph` is consumed directly by `exportGraphs.ts` and re-exported from `graph/index.ts`. Replace with `getCaseGraph(flags)` reading from the boot-time map.

### 5. Export all four diagrams

```
docs/graphs/case-graph.none.svg
docs/graphs/case-graph.procedure-preselection.svg
docs/graphs/case-graph.translation-sandwich.svg
docs/graphs/case-graph.translation-sandwich+procedure-preselection.svg
```

Name by activated flags, sorted, `+`-joined; `none` when no flags are set. Keep the existing `collapseSubgraphs` behaviour for readability. Write an index listing the four so a deployer can find the picture of the pipeline they are running.

### 6. `procedures`-only requests

Decide and enforce: `generationFlags: ["procedures"]` alone is schema-valid today, produces an empty presentation fan-out, and hands the blinded solver an empty patient — after paying for a plan and up to three evaluations. Either declare presentation fields a prerequisite of `procedures` and reject at the API boundary (simpler, probably matches reality), or inject the plan's presentation summary into the solver. **Recommend rejecting**; record the choice in the design doc's open decisions.

## Acceptance criteria

- [ ] `assembleCaseGraph` is pure: same `(runtime, flags)` → structurally identical graph, no I/O
- [ ] Four variants exist after boot; a fifth is never constructed
- [ ] Test: with `TRANSLATION_SANDWICH=false`, no translation node appears in `getGraphAsync()` output
- [ ] Test: with it true, both translation nodes appear
- [ ] Test: the `procedures` conditional edge exists in all four variants
- [ ] `pnpm graph:export` writes four SVGs with flag-derived names
- [ ] `grep -rn "export const caseGraph" src/` returns nothing
- [ ] A `procedures`-only request is rejected with a clear message (or documented as supported)

## Out of scope

Language binding (09) — variants are flag-only; languages must not multiply them.
