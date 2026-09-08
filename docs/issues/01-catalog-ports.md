# 01 — Catalog module and ports

**Depends on:** 00 · **Blocks:** 02, 03, 04, and everything downstream
**Design ref:** `architecture-target.md` §7, §7.5, §6.1

## Why

The catalog is currently a **shallow module**: `03repo/procedures.repo.ts` exports a list and a `Map`, while everything that makes a catalog interesting — deciding flat vs grouped, narrowing to categories, excluding already-ordered procedures, building the literal-union grammar, reassembling `"Category: Name"` — lives inside the prompt builder. About **240 lines** of catalog logic sit in `03aigateway/procedures.aigateway.ts:132-370`, reached through **25 direct calls** to four repo functions.

This issue makes the catalog own its own concept, behind a port.

## Current state

**The catalog logic to move**, all in `03aigateway/procedures.aigateway.ts`:

| Line | Function                     |
| ---- | ---------------------------- |
| 132  | `resolveProcedurePickMode`   |
| 150  | `excludeOrderedFromGrouped`  |
| 175  | `excludeOrderedFromMode`     |
| 198  | `modeHasCandidates`          |
| 214  | `scopeGroupedProcedures`     |
| 237  | `renderCategoryMenu`         |
| 259  | `procedureCandidatesSection` |
| 282  | `procedurePickGrammarSchema` |
| 316  | `procedurePickPromptSchema`  |
| 338  | `assembleProcedurePick`      |

**The repo side:** `03repo/procedures.repo.ts` (`getEffectiveProcedureList`, `getGroupedProcedures`, `getProcedureCategories`, `parseProcedureName`, `UNCATEGORIZED_CATEGORY`, `PredefinedProcedureNames`), `03repo/anamnesis.repo.ts` (`getEffectiveCategoryList`), `03repo/predefinedList.ts` (`resolvePredefinedList`).

**Consumers outside the gateway:** `02graphs/02case-generation/03procedure/index.ts:27,117-119`; `03aigateway/anamnesis.aigateway.ts:6`; `03aigateway/case.aigateway.ts:10`; `extensions/rest/routes/procedures.router.ts:2`.

## Task

### 1. Delete Rule 4

`03repo/predefinedList.ts:78-113` implements four rules. **Rule 4** — "translation keys only ⇒ the effective list for a language is whatever has a translation" — inverts the intended contract: it lets _translations define the vocabulary_. Delete it.

Consequence: `getEffectiveProcedureList(language)`, `getEffectiveCategoryList(language)` and `getProcedureCategories(language)` lose their `language` parameter entirely. This is the change that makes the generation core language-independent (design §5.1), so do not skip it.

Keep Rule 3 (`process.exit(1)` on a translation key absent from the catalogue) — issue 02 improves its error message.

### 2. Define the ports

```ts
// src/core/graph/catalog/ports.ts
export interface ProcedureCatalog {
  /** All procedure names, in catalogue order. */
  list(): ProcedureName[];
  /** Real categories, first-seen order, excluding the synthetic bucket. */
  categories(): string[];
  /** Bare names grouped by category. */
  grouped(): Map<string, ProcedureName[]>;
  /** A candidate set narrowed to these categories (plus the uncategorized bucket). */
  scope(categories: string[]): ProcedureCandidates;
  /** The full candidate set. */
  candidates(): ProcedureCandidates;
}

export interface ProcedureCandidates {
  /** Remove already-ordered procedures. Returns a new candidate set. */
  exclude(ordered: ProcedureName[]): ProcedureCandidates;
  isEmpty(): boolean;
  /** Zod schema constraining a pick to this set — the grammar sent to the provider. */
  grammar(): z.ZodTypeAny;
  /** Name-agnostic schema for the prompt (see renderSchemaForPrompt). */
  promptSchema(): z.ZodTypeAny;
  /** Rendered candidate list for the prompt body. */
  render(): string;
  /** Turn a model's pick back into full "Category: Name" values. */
  assemble(pick: unknown): ProcedureName[];
}

export interface AnamnesisCatalog {
  list(): AnamnesisCategory[];
}
```

`AnamnesisCatalog` is deliberately _not_ a generic `Catalog<T>`: procedures carry a taxonomy and categories do not, and forcing one interface over both produces an interface as complex as the two implementations. Share the _adapter_, not the port.

### 3. Move the logic

Move the ten functions listed above out of `procedures.aigateway.ts` and into the `ProcedureCatalog` implementation. The gateway's job shrinks to: take a `ProcedureCandidates`, put `render()` in the prompt, use `grammar()` as the structured-output schema, call `assemble()` on the response.

### 4. Adapters

- `YamlProcedureCatalog` — today's behaviour, backed by the existing SQLite sync.
- `InMemoryProcedureCatalog` — takes a plain string array. Needed by tests and by issue 07.

Both live under `src/core/graph/catalog/`.

### 5. Wiring, for now

Ports are constructed at module scope for this issue and imported by the gateway. **Issue 04 replaces that with proper injection** — do not try to solve dependency injection here, or this PR becomes unreviewable.

## Acceptance criteria

- [ ] `grep -rn "language" src/core/graph/03repo/procedures.repo.ts src/core/graph/03repo/anamnesis.repo.ts` returns nothing
- [ ] Rule 4 is gone from `predefinedList.ts`; the doc comment describes three rules
- [ ] `procedures.aigateway.ts` is under ~1,400 lines and contains none of the ten functions listed above
- [ ] `procedures.aigateway.ts` imports nothing from `03repo/`
- [ ] Tests: given an `InMemoryProcedureCatalog` of known names, `candidates().exclude([...]).grammar()` rejects an excluded name and accepts a remaining one
- [ ] Tests: a flat (uncategorized) catalogue yields `categories() === []`
- [ ] `pnpm build` passes and a generation still produces the same output for a fixed input

## Out of scope

Dependency injection (04), configurable paths (02), the translation store (03), `LabelCatalog` and `DiagnosisCatalog` (02).
