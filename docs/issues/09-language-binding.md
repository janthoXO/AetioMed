# 09 — Language binding

**Depends on:** 02, 03, 06, 08 · **Blocks:** 10, 12
**Design ref:** `architecture-target.md` §5.1, §5.3

## Why

Language must become a property of the **bound ports**, not of graph state or runtime context — that is what makes the generation core language-agnostic by construction rather than by discipline, and what keeps the four compiled variants from multiplying by the number of languages.

## Current state

- `utils/context.ts:11-15` — `RequestContextSchema` declares `language`, but `runWithContext` (`:24-55`) **never populates it**. The ALS field is dead; language travels only via LangGraph's runtime context, passed at `caseGraph.ts:104-108` and read as `runtime?.context?.language` (e.g. `03procedure/index.ts:241`).
- Subgraph **state is filtered** by the child's schema (`pregel/io.js:81`) but **context is not** — `_validateContext` (`graph/state.js:552`) parses against the context schema and then **discards the result**, returning the original object. So a narrower `contextSchema` does not strip anything. Splitting graphs cannot fix a context leak; removing the field can.
- After issue 01 deleted Rule 4, the six catalog call sites no longer take `language` at all.

## Task

### 1. Catalog binding differs by mode

| Mode | Generation binds | Translate-out binds |
|---|---|---|
| `TRANSLATION_SANDWICH=true` | **English catalogs only** — generation never sees a foreign term | target-language catalogs |
| `TRANSLATION_SANDWICH=false` | **target-language catalogs**, used directly as generation vocabulary | *(no translate-out)* |

In non-sandwich mode the model **selects** from a localized literal union rather than translating — the grammar does the work, not the prompt.

### 2. Internal artifacts stay English in both modes

Split roles (issue 06) by audience:

| Class | Roles | Language, sandwich off |
|---|---|---|
| **Internal** — plan, plan judge, blinded solver reasoning, `matchDiagnosis` | `generator` (plan), `judge` | **English, always** |
| **User-visible** — chief complaint, anamnesis answers, procedure result text | `generator` (fields, results) | target language |

Mechanically this is one extra port binding, not a new concept: internal roles bind an English-directive model, user-facing roles bind a target-language one.

### 3. The language directive

Appended by the LLM port as the **final line of the system message** — constant per language, so it stays inside the stable prefix and does not disturb prompt caching. Never in the user message.

```
Output language: {language}.
Write all free-text field VALUES in {language}.
Field names, enum values and identifiers are fixed by the schema —
reproduce them exactly, untranslated.
```

The second sentence is load-bearing: under structured output a model told to "answer in German" will translate JSON keys and enum members. `relevance` is `obligatory | optional | contraindicated`; the grammar rejects a translated value, but the retry costs a call.

Optional, cheap, do it here: localized `.describe()` text on the Zod schema fields. Models follow schema descriptions well.

### 4. Remove `language` from state and context

- Delete it from `RequestContextSchema` (`utils/context.ts:14`) — it was never populated.
- Delete it from the LangGraph runtime context passed at `caseGraph.ts:104-108`.
- Delete it from `CaseStateSchema` (`caseGraph.ts:18-26`). The outer graph resolves language before invoke and binds ports; the graph itself carries none.

### 5. `Language` from configuration

`models/Language.ts:3` is `z.enum(["English", "German"])` and `CaseGenerationRequestSchema` derives from it — so adding French edits source **and** changes the public API contract. Make the supported set come from deployment config, validated at startup against which catalogs actually have translations. The request schema validates against the configured set at runtime.

## Acceptance criteria

- [ ] `grep -rn "language" src/core/graph/02graphs/` returns nothing — make this a CI check
- [ ] `RequestContextSchema` has no `language`
- [ ] Test: with the sandwich on, the catalog port handed to generation returns English terms only
- [ ] Test: with it off, the port returns target-language terms and the grammar accepts them
- [ ] Test: internal roles receive no language directive (or an English one) in both modes; user-facing roles receive the target directive only with the sandwich off
- [ ] Adding a third language is a config change plus a translation YAML — no source edit
- [ ] Four compiled variants, unchanged by the number of configured languages

## Notes

Ports carried in `AsyncLocalStorage` are invisible to checkpoints — anything resumable (F09) must rebuild them from the request. Same problem as `llmConfig`; solve it once, in assembly.
