# 07 — ProcedureStrategy port and the blinded solver split

**Depends on:** 04 · **Blocks:** 08
**Design ref:** `architecture-target.md` §6.5, §6.1

## Why

Two procedure-selection strategies already exist, but as **branches of a global env read inside a node** rather than as two adapters. The result is 8 tools expressing 3 concepts and 7 near-duplicate gateway functions. Separately, the blinded/oracle information asymmetry — the pipeline's best idea — is maintained by convention rather than structure.

## Current state

**The branch:** `02graphs/02case-generation/03procedure/index.ts:117-119`

```ts
function useSmallModelSplit(language) {
  return config.LLM_SMALL && getProcedureCategories(language).length > 0;
}
```

read at `:241` (blinded step) and `:472` (bridge).

**Verified:** `LLM_SMALL` gates **nothing else** in the codebase. `PROCEDURE_PRESELECTION` replaces it one-for-one; delete `LLM_SMALL` from `graph/config.ts:21` outright, no alias, no deprecation.

**The asymmetry leak:** `03procedure/index.ts:44-49`

```ts
const ProcedureGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,        // ← the blinded step receives this and declines to use it
  userInstructions: true,
  case: true,
  outline: true,
})
```

**The 8 tools:** `03procedure/tools.ts` — `generateBlindedProcedureStep`, `generateBlindedCategoryStep`, `generateBlindedProcedureStepFromCategories`, `generateProcedureResults`, `generateDiagnosisBridge`, `generateBridgeCategoryStep`, `generateBridgeProcedureStepFromCategories`, `matchDiagnosis`.

## Task

### 1. The port

```ts
interface ProcedureStrategy {
  nextStep(view: BlindedView): Promise<SolverMove>;
  bridge(view: OracleView): Promise<ProcedureResult[]>;
}

type BlindedView = {                    // structurally cannot carry the diagnosis
  presentation: Presentation;
  previousProcedures: ProcedureResult[];
  ruledOutDiagnoses: string[];
  userInstructions?: string;
  iterationsRemaining: number;
  candidates: ProcedureCandidates;      // from issue 01
};

type SolverMove =
  | { action: "order"; procedures: Procedure[] }
  | { action: "diagnose"; diagnosisName: string }
  | { action: "exhausted" };            // replaces today's empty-pick-means-bridge inference
```

### 2. Two adapters

- **`DirectPick`** — today's `generateBlindedProcedureStep` / `generateDiagnosisBridge` path.
- **`CategoryScopedPick`** — today's `resolveBlindedStepViaCategories` (`:139-221`) and `resolveBridgeViaCategories` (`:401-456`), including the expand loop and its `MAX_CATEGORY_EXPANSIONS` cap (`:42`), and the bridge's deterministic single widening retry.

Selected at assembly by `PROCEDURE_PRESELECTION`, not at runtime.

### 3. Node becomes thin

`blindedStep` becomes: call `strategy.nextStep(view)`, switch on the move. The three-node graph shape (`blinded_step`, `result_step`, `bridge`) stays fixed regardless of strategy — the current code asserts this as an invariant in comments; now it is one.

### 4. Split the blinded solver's state

Make the blinded step its own subgraph whose state schema **omits `diagnosis`**. Oracle nodes (`result_step`, `bridge`, `matchDiagnosis`) stay in the parent, which has it. The parent passes a presentation down and gets a `SolverMove` back.

Subgraph state **is** filtered by the child's schema (`@langchain/langgraph/dist/pregel/io.js:81`), so a key absent from the child schema never enters its channels. This makes the guarantee structural rather than conventional.

### 5. Collapse the tools

Five of the eight tools stop existing as separate tools — they become strategy internals. Keep `generateProcedureResults` and `matchDiagnosis` as tools (they are oracle-side and strategy-independent).

## Acceptance criteria

- [ ] `grep -rn "LLM_SMALL" src/` returns nothing
- [ ] `PROCEDURE_PRESELECTION` selects the strategy at assembly; no node reads it at runtime
- [ ] `03procedure/index.ts` contains no `resolveBlindedStepViaCategories` / `resolveBridgeViaCategories`
- [ ] The compiled procedure graph has exactly three nodes under both flag values
- [ ] `BlindedView` has no `diagnosis` field, and the blinded subgraph's state schema does not declare it
- [ ] Test: a fake strategy drives the loop through order → results → order → diagnose(correct) → END with no LLM calls
- [ ] Test: iteration cap exhaustion routes to bridge
- [ ] Test: a wrong diagnosis adds to `ruledOutDiagnoses` and continues
- [ ] `procedures.aigateway.ts` shrinks by roughly the seven near-duplicate functions

## Notes

Already-ordered procedures are excluded from the candidate grammar (issue 01's `exclude()`), so duplicate orders remain impossible by construction. Preserve that — it is load-bearing and currently documented in comments as such.
