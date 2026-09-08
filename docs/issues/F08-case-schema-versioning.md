# F08 — Case schema versioning

**Status:** Future work — **do it with issue 11** · **Depends on:** 11
**Design ref:** `architecture-target.md` §10.7

## Summary

`CaseSchema` is a public contract the moment the project is open-sourced and cases are persisted. Version it before v1.

## Why now

Issue 11 changes three fields from `string` to `ContentPart[]` — the largest schema break the project will make. Doing versioning in the same release means there is exactly one break, with a version marker that makes future breaks manageable. Doing it afterwards means two breaks.

## Design sketch

- Add `schemaVersion` to the response and to any persisted case.
- Adopt a documented compatibility policy: additive fields are minor, removed or retyped fields are major.
- Where the API and the domain differ (issue 11 splits the LLM schema from the wire schema), version the **wire** schema — that is the public one.
- Generate the OpenAPI description from Zod in one place so the documented shape cannot drift from the served shape. `zod-openapi` is already a dependency.

## Notes

Consider whether the response should carry English `id` plus localised `label` for controlled-vocabulary fields, rather than localised strings alone — the payload-identity question still open from `translation-decoupling.md`. Under localised-only, a caller cannot tell that `"Bluttest"` and `"Blood Test"` are the same procedure without an ambiguous reverse lookup. That decision belongs in the same release as the version marker.
