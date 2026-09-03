# Decouple translation from the generation graph

**Type:** Refactor · **Scope:** `src/core/graph/`, `src/core/translation/` (new), `src/extensions/tracingNats/`

## Summary

Move all translation logic out of the generation graph and into a sibling package, so the graph operates on a purely English working set. Translation becomes a wrapper around `generateCase()` rather than two phases inside it.

Target end state:

```
src/core/
├── graph/         ← English only. Knows nothing about language.
└── translation/   ← wraps graph. translateIn → generateCase → translateOut
```

Removing translation later means deleting `src/core/translation/` and pointing the transports at `generateCase()` directly.

## Motivation

Two reasons, in order of importance:

1. **The current coupling is accidental, not designed.** `language` is threaded through six call sites inside the graph to reach code paths that are unreachable in our actual configuration (see audit below). The graph is already language-free in practice; it just doesn't say so.
2. **Frontier models may eventually handle multilingual output directly.** If that happens, we want removal to be a directory deletion, not surgery.

Note that (2) is weaker than it sounds and should not drive the design. Roughly 60% of the pipeline's LLM calls produce artifacts the user never sees — the outline, the outline judge, the blinded solver step, `matchDiagnosis`, symptom generation. Those should run in English regardless of how good models get, because English is the thicker slice of every model's clinical training distribution and there is no upside to the German path. An English canonical core also keeps the ICD-keyed symptom cache language-invariant and keeps generations comparable across languages for evaluation.

What frontier models could obsolete is only the free-text LLM translation call — one of four concerns. Design for the canonical core; treat removability as a bonus that falls out of it.

## Current coupling — audit

### `RequestContext.language` reaches six places inside the graph

| Call site                             | Uses                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `03aigateway/case.aigateway.ts`       | `getEffectiveCategoryList(context?.language)`                                 |
| `03aigateway/anamnesis.aigateway.ts`  | `getEffectiveCategoryList(context?.language)`                                 |
| `03aigateway/procedures.aigateway.ts` | `getEffectiveProcedureList`, `getGroupedProcedures`, `getProcedureCategories` |
| `02graphs/.../03procedure/index.ts`   | `useSmallModelSplit(runtime?.context?.language)`                              |

**All of these are currently no-ops.** `data/procedures.yml` has 152 entries and `data/anamnesisCategories.yml` has 7, so `resolvePredefinedList` returns a defaults list, `PredefinedProcedureNames` / `AnamnesisCategoryDefaults` are defined, and `getEffective*List` returns the English list on its first line without ever reading `language`:

```ts
if (PredefinedProcedureNames !== undefined) return PredefinedProcedureNames; // ← always taken
if (language && language !== "English") {
  /* Rule 4 — unreachable */
}
```

### Rule 4 encodes a design we don't want

`predefinedList.ts` Rule 4 ("no defaults, only translation keys → the effective list for a language is whatever has a translation") makes _translations define the vocabulary_. Our intent is the opposite: **the catalog file defines the vocabulary; the translation file is a partial cache seed.**

Rule 4 exists only to guarantee the output translator can resolve every generated term. Once controlled-vocabulary translation is a deterministic dictionary lookup backed by a startup completeness check, that guarantee moves to boot time and the runtime filter is unnecessary.

### Other language touchpoints

- `caseGraph.ts` — two conditional edges on `state.language !== "English"` routing to the translation subgraphs.
- `utils/nodeWrapper.ts` — `resolveLabel()` + `knownLabels` / `getKnownLabels()`.
- `02graphs/caseGraph.ts` — `generateCase()` pre-warms the label cache via `ensureLabelsTranslated()` before invoking the graph.
- `utils/context.ts` — `RequestContextSchema` carries `language`.

## Design

### 1. Package boundary

`src/core/translation/` exposes a localized entry point that wraps the graph's:

```
generateCaseLocalized(request including language) → Case
  └── generateCase(request WITHOUT language) → Case
```

**Do not give them identical signatures.** The wrapper accepts `language`; the core must not accept it at all. Then deleting `src/core/translation/` produces a compile error at every call site that passes `language`, instead of a silent behavior change.

The enforcement point is `RequestContextSchema` — **remove `language` from it**. If it stays, the graph can still reach it and the coupling returns within a release or two.

Transports keep calling `runWithContext(...)`; only the function they invoke inside it changes.

### 2. Catalog semantics

Make the contract explicit and enforce it at startup:

- **Catalog files** (`procedures.yml`, `anamnesisCategories.yml`) are the single source of vocabulary. Always English, always complete. If present and non-empty, they constrain generation for every language.
- **Translation files** (`*Translations.yml`) are a partial cache seed, keyed by the English catalog entry.

Startup validation, stated as an asymmetry because it reads backwards otherwise:

| Condition                               | Action                                               |
| --------------------------------------- | ---------------------------------------------------- |
| Translation key **not in** the catalog  | **Panic** (typo or stale entry)                      |
| Catalog entry **missing** a translation | Allowed — filled by LLM on first use, then persisted |

`resolvePredefinedList` already implements the first row (Rule 3, `process.exit(1)`). **Delete Rule 4** and drop the `language` parameter from `getEffectiveProcedureList`, `getEffectiveCategoryList`, `getProcedureCategories`, and `useSmallModelSplit`.

**Add translation provenance.** The `translation` table is `(domain, lang, english, translated)`. Add `source: 'curated' | 'generated'`. Without it, an LLM-invented German name for a procedure is cached permanently and is indistinguishable from a reviewed one — "deterministic" would mean _stable_, not _correct_. With it, we can list unreviewed translations and promote them into YAML.

### 3. Field-wise translation

Replace the whole-case `translateCase` call with a per-field split, partitioned by **field ownership** so the two passes touch disjoint fields:

| Field                        | Direction | Mechanism             |
| ---------------------------- | --------- | --------------------- |
| `diagnosis` (free text only) | in        | Dictionary → LLM fill |
| `userInstructions`           | in        | LLM                   |
| `anamnesis[].category`       | out       | Dictionary → LLM fill |
| `procedures[].name`          | out       | Dictionary → LLM fill |
| `chiefComplaint`             | out       | LLM                   |
| `anamnesis[].answer`         | out       | LLM                   |
| `procedures[].result`        | out       | LLM                   |

Disjoint field ownership means ordering no longer matters, which removes the current bug where `translate_values` overwrites the controlled-vocabulary translations. It also shrinks the LLM payload — we stop shipping 152-character compound procedure names through it.

`translate-in` should trigger on **provenance** (did the caller supply a free-text diagnosis?), not on `language !== "English"` — see bugs below.

### 4. Trace labels — remove the machinery entirely

The current design pre-warms a label cache before generation so `traceNode` can resolve labels synchronously on the hot path. This is unnecessary.

`label` is consumed by exactly one place: `tracingNats`. The `tracing` extension's `emitToTraceBus` forwards only `{ node, timestamp }`, so the SSE stream (`tracingRest`) never receives a label at all. The entire pre-warm exists to serve one consumer.

Proposal:

- Core emits **English labels only**. Delete `resolveLabel()`, `knownLabels`, and `getKnownLabels()` from `nodeWrapper.ts`.
- Delete the `ensureLabelsTranslated()` pre-warm from `generateCase()`.
- `tracingNats` localizes on the way out, lazily — it isn't on the generation hot path, so no blocking call is needed anywhere.

This is simpler than warming the cache at the API layer, and it removes one of the two core→extension leaks (`utils/context.ts` importing `setupTracing` from `@/extensions/tracing/` is the other, out of scope here).

## Blocking decision: payload identity

**Nothing above resolves what identity a procedure or category has in the response, and that decision constrains the rest.**

| Option | Response shape                       | Consequence                                                                                                                      |
| ------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| A      | English identifiers only             | Caller localizes from its own bundle. Cleanest, requires caller cooperation.                                                     |
| B      | Localized display strings            | Current behavior. Caller cannot tell `"Bluttest"` and `"Blood Test"` are the same procedure without an ambiguous reverse lookup. |
| C      | `id` (English) + `label` (localized) | Schema change; identity and presentation both explicit.                                                                          |

Recommend **C**. It is the only option where removing translation later breaks nothing: `id` still comes from the approved English list via the grammar constraint, `label` still comes from the dictionary, and dropping the free-text LLM pass affects only prose. Under B, a natively-multilingual model would emit German procedure names and break name matching in the calling software.

**Related — compound names.** Procedures are stored as `"Category: Name"` and split by `parseProcedureName` on the first `": "`. The translation file translates the whole compound as a unit, so ~31 categories are re-translated across 152 rows (`"Kardiologie (ohne Radiologie)"` appears ~10 times). Two consequences:

- Renaming a category means editing every row it appears in.
- The German category taxonomy is never validated. If one fill-path translation renders the prefix differently, a category silently splits in any client that groups by prefix.

Splitting `category` and `name` into separate fields with separate translation domains fixes both and is a prerequisite for option C.

## Bugs fixed as a side effect

- **Controlled translations overwritten.** `translate_anamnesis_category` / `translate_procedures_names` run before `translate_values`, which re-translates the whole case and replaces `case.anamnesis` / `case.procedures` through the shallow reducer merge. Works today only because an LLM shown German usually echoes it back — non-deterministic in exactly the fields that must be deterministic. Fixed by §3.
- **`userInstructions` is never translated.** `CaseTranslationToEnglishStateSchema` carries only `{ diagnosis, generationFlags, language }` and the phase has one node. German instructions currently flow into English prompts unmodified. Fixed by §3.
- **ICD path translates an already-English name and pollutes the store.** When a request supplies only `icd`, the router resolves the English name from the DB; the graph then routes to `translate_diagnosis` anyway, the cache reverse-lookup misses, the LLM is called on English input, and `saveDiagnosisTranslations` persists `German: { "Diabetes": "Diabetes" }`. Fixed by triggering translate-in on provenance.
- **No in-flight dedup for procedure/category translation.** Those tools hand-roll their own cache-aside loop instead of using `translationStore.translateMissing`, so concurrent first-requests in a new language both pay for the LLM call. Consolidate onto `translateMissing`.

## Out of scope

- Native multilingual generation (letting the model emit German directly). Requires measurement first — see below.
- The `utils/context.ts` → `extensions/tracing/` import leak.
- Extracting a shared `callStructuredLLM` helper (tracked separately in `engineering-review.md` §5.2).

## Acceptance criteria

- [ ] `language` removed from `RequestContextSchema`; no file under `src/core/graph/` references it
- [ ] Rule 4 deleted; `getEffectiveProcedureList` / `getEffectiveCategoryList` / `getProcedureCategories` / `useSmallModelSplit` take no `language` argument
- [ ] Startup check panics on translation keys absent from the catalog; missing translations allowed
- [ ] `source: curated | generated` column added to `translation`; migration generated via `pnpm db:generate`
- [ ] Translation subgraphs removed from `caseGraph.ts`; both conditional edges gone
- [ ] `src/core/translation/` wraps `generateCase()`; transports call the wrapper
- [ ] Translate-out split by field ownership; controlled and free-text passes touch disjoint fields
- [ ] Translate-in covers `userInstructions` and triggers on provenance, not language
- [ ] Label localization moved to `tracingNats`; `resolveLabel` / `getKnownLabels` / pre-warm deleted
- [ ] Payload identity decision made and implemented
- [ ] Deleting `src/core/translation/` produces compile errors, not silent behavior change

## Follow-up: is native multilingual generation worth it?

Open question, deliberately deferred because it is empirical and model-dependent.

The value and risk run in opposite directions across fields. Anamnesis answers are written in "the patient's subjective voice, layman's terms" — register and idiom are exactly what translation destroys, so native generation has the highest value there and its failure mode is cosmetic. Procedure results are mostly numbers and units, so translation is nearly lossless, native generation risks mangled terminology attached to clinically load-bearing values, and the failure mode is clinical. Chief complaint sits in between and is close to a dictionary operation.

At ~4B, expect native generation to lose: language drift mid-output, weaker German medical terminology, and worse schema compliance from juggling structured output and cross-lingual generation in one pass. That last one matters most — it contradicts the decomposition principle the rest of this codebase already relies on (outline-as-blueprint, blinded/oracle split, `LLM_SMALL` category-then-procedure). If we don't trust a small model to pick from a 152-item list in one shot, we shouldn't trust it to generate correct German under a schema in one shot.

Note the current comparison is unfair: `translateCase` is a single whole-case structured-output call, the worst possible baseline. Land §3 first, then compare decomposed translation against native generation.

To answer it: generate ~10 cases both ways for the same diagnoses and have a German-speaking clinician rate fluency, terminological correctness, and patient-voice naturalness separately. That is also the cheapest first brick of the evaluation harness we're missing (`engineering-review.md` §6.4), and it needs re-running whenever `LLM_MODEL` changes.

One structural note for whenever this happens: the natural fracture line is **identifier vs. content**. `anamnesis[].category` and `procedures[].name` are identifiers and stay English; `answer` and `result` are content and could go native. That is the same split as §3's dictionary-vs-LLM partition — so §3 is a prerequisite for either future, not speculative work.
