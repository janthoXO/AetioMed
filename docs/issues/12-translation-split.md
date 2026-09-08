# 12 — Translation split: defined and rest passes

**Depends on:** 09, 11 · **Blocks:** nothing
**Design ref:** `architecture-target.md` §11.3

## Why

**This fixes a live bug.** The controlled vocabulary is silently overwritten by free-text LLM output today, and only appears to work because a model shown German usually echoes it back — non-deterministic in exactly the fields that must be deterministic.

## Current state — the bug, precisely

In `02graphs/03case-translation-from-english/index.ts`:

1. `translate_anamnesis_category` (`:11-40`) and `translate_procedures_names` (`:42-68`) run first, writing cache-backed controlled translations.
2. Both edge into `translate_values` (`:129-130`) — there is **no path that skips it**.
3. `translate_values` (`:70-85`) sends the **entire case** through one free-text LLM call and returns a full `Case`.
4. The `case` reducer (`state.ts:25-32`) is a shallow merge:
   ```ts
   reducer: {
     fn: (prev, next) => ({ ...prev, ...next });
   }
   ```
   `next` carries its own `anamnesis` and `procedures` arrays, so the LLM's versions **replace** the controlled ones wholesale.

The prompt says "translate only the VALUES, do not translate keys" — but categories and procedure names _are_ values.

## Task

### 1. Two passes over disjoint field sets, then merge

```
Case (English) ──┬── defined pass  (deterministic) ──┐
                 └── rest pass     (LLM, text only) ─┴── merge ── Case (target)
```

| Pass        | Handles                                                                    | Mechanism                                                             |
| ----------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Defined** | `procedures[].name`, `anamnesis[].category`                                | Catalog dictionary lookup; per-key locked LLM fill on miss (issue 03) |
| **Rest**    | every `ContentPart.alt`                                                    | One LLM pass over `alt` strings only                                  |
| **Neither** | `value` bytes of non-text parts, enums (`relevance`), identifiers, numbers | Passed through untouched                                              |

Because the sets are **disjoint**, ordering no longer matters and the merge is unambiguous. That is the structural fix — not a reordering of the existing nodes.

### 2. Translate `alt`, then re-derive text values

With `ContentPart[]` (issue 11), **only `alt` is ever sent to the translator** — exactly one string per part.

- For a `text/*` part, `value` is then **re-derived** as `utf8(translatedAlt)` via the `textPart()` constructor. Never translate `value` independently: it is a derived field, so re-deriving it means `alt` and `value` cannot disagree after translation.
- For every other part, `value` passes through **byte-identical**. Non-text content is excluded by construction, not by a prompt instruction asking the model to leave it alone.

This also keeps binary payloads out of the translation call entirely, which matters: a whole-case round trip through `withStructuredOutput` over base64 would be mangled by a small model with near-certainty.

### 3. Translate-in as well

`01case-translation-to-english/` currently translates **only** `diagnosis.name` (one node). `userInstructions` is never translated, so German instructions flow into English prompts unmodified. Fix it in the same pass.

Trigger translate-in on **provenance** — did the caller supply free text? — not on `language !== "English"`. Today, an ICD-only request resolves an English name from the DB and then translates it anyway, polluting the store with `German: { "Diabetes": "Diabetes" }`.

### 4. Payload shrink

The rest pass no longer ships 152-character compound procedure names through the LLM. Note the reduction; it matters on small models.

## Acceptance criteria

- [ ] Test: a case whose procedure names are all in the catalogue is translated with **zero** LLM calls for names
- [ ] Test: after translation, `procedures[].name` values are exactly the catalogue's target-language terms — not paraphrases
- [ ] Test: the two passes touch disjoint field sets (assert by construction, not by output)
- [ ] Test: reversing pass order produces an identical result
- [ ] Test: a non-text content part's `value` is byte-identical after translation, while its `alt` is translated
- [ ] Test: for a text part, `value === utf8(alt)` still holds after translation
- [ ] Test: no base64 or byte payload appears in any translation prompt
- [ ] `userInstructions` is translated on the way in
- [ ] An ICD-only request performs no translate-in and writes no identity translations
- [ ] The whole-case `translateCase` call is gone

## Notes

Whole-case translation is also structurally incompatible with multimodal content — one `withStructuredOutput(CaseSchema)` round-trip over binary payloads would be mangled by a small model with near-certainty. This split is therefore a prerequisite for issue 13, not an independent cleanup.
