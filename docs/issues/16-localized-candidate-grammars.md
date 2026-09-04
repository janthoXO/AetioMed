# 16 — Localized candidate grammars for non-sandwich mode

**Depends on:** 09 · **Blocks:** nothing
**Design ref:** `architecture-target.md` §5.1

## Why

Split out of issue 09 during its implementation (the same way issue 07 was split from the 05
round) rather than folded in as a sub-clause, because it is a real design question, not a
clarification of one already made.

`architecture-target.md` §5.1's table wants non-sandwich generation to *select* controlled
vocabulary from a localized literal union — "the grammar does the work, not the prompt" — the
same way sandwich mode's translate-out phase already looks up target-language terms instead of
asking an LLM to translate them. Issue 09 deliberately did **not** implement this: with the
sandwich off today, `procedures[].name` and `anamnesis[].category` are still picked from the
**English** catalogue's literal union, so they come back English in an otherwise-localized
non-sandwich response. That gap is documented in `CLAUDE.md`'s Language section and in
`03aigateway/procedures.aigateway.ts`/`anamnesis.aigateway.ts` as a known limitation, not an
oversight.

## The tension with issue 01

Issue 01 (`01-catalog-ports.md`) deleted "Rule 4" — the catalogue lookups that used to take a
language parameter — specifically so catalogue reads became language-independent and the six
call sites simplified to `list()`/`candidates()` with no language argument at all. That
simplification is real and worth keeping for the callers that don't need localization (sandwich
mode's generation phase, which is English-only by construction after issue 09).

Solving this issue reverses that simplification for **one specific caller**: non-sandwich
generation needs a catalogue *view* bound to the request's target language, so the literal
union in the structured-output schema is already in that language. That requires either:

- Reintroducing a language parameter on `ProcedureCatalog`/`AnamnesisCatalog` (or the
  `candidates()` view built from them) — which un-does issue 01's simplification for every
  caller, not just the non-sandwich one, unless carefully scoped; or
- A second, language-bound adapter constructed only for the non-sandwich generation phase (the
  same "adapter per compiled variant" shape issue 09 used for `GraphRuntime.languageOverride`),
  leaving the language-independent port issue 01 introduced untouched for every other caller.

The second is very likely the right shape — issue 09's `languageOverride` binding on
`GraphRuntime` at graph-assembly time is a direct precedent, and it stays a **per-request**
choice within a **compiled** variant so the "four compiled variants, not one per language" rule
still holds — but this needs to be worked through as its own decision, including how the
translation store backs the localized catalogue (an LLM-filled cache-aside store like
`translationStore.ts`'s existing procedure/category translations, likely reused rather than
duplicated) and what happens when a term has no translation yet at request time.

## Task

1. Design and implement a per-request, language-bound view over `ProcedureCatalog`/
   `AnamnesisCatalog`'s candidate lists, scoped to the non-sandwich generation phase only —
   the sandwich-on generation phase, and every other current caller of `candidates()`/`list()`,
   must stay on the language-independent port issue 01 introduced.
2. Wire it into `03procedure/` (`generateBlindedProcedureStep` and friends) and the anamnesis
   category grammar (`buildAnamnesisSchema`) for the non-sandwich topology specifically — the
   sandwich topology's generation phase continues to bind English catalogues (issue 09 §1 of
   the design doc's table).
3. Decide the missing-translation behaviour at request time: fall back to English (matching the
   translation store's existing degrade-to-English policy for labels/procedures), or block on a
   synchronous LLM fill. Prefer the former unless the cost analysis says otherwise — it's the
   existing pattern.
4. Remove the "controlled vocabulary stays English in non-sandwich mode" caveat from
   `CLAUDE.md`'s Language section and the two aigateway files' comments once this lands.

## Acceptance criteria

- [ ] With the sandwich off and a non-English `language`, `procedures[].name` and
      `anamnesis[].category` in the response are in the target language, not English
- [ ] The grammar itself rejects an off-vocabulary term — the model selects, it does not
      translate (no LLM call spent per-request on localizing these fields)
- [ ] `candidates()`/`list()` (issue 01's language-independent port) are unchanged for every
      other caller — this issue adds a new, narrowly-scoped view, it does not widen the
      existing one
- [ ] Four compiled variants still, unchanged by the number of configured languages (same rule
      issue 09 §1 states for the request-level language binding)
- [ ] A missing translation degrades to English rather than failing the request, consistent
      with `translationStore.ts`'s existing fallback policy

## Notes

This is the mechanical dual of issue 12's "defined pass" for sandwich mode's translate-out
phase — both are "look the controlled term up in a target-language index instead of asking an
LLM to translate it." Building this issue's mechanism early (i.e. inside issue 09) would have
duplicated machinery issue 12 restructures; that duplication is exactly what this split avoids.
