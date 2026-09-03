# 00 — Test infrastructure

**Depends on:** nothing · **Blocks:** every issue that has a verifiable guarantee
**Design ref:** `architecture-target.md` §10.6

## Why

There is no test runner in the repository — no `*.test.ts`, no vitest or jest in `package.json`. Several guarantees in the target architecture are *concurrency* or *absence* properties that cannot be verified by running one generation by hand:

- "an empty medical-basis registry costs zero LLM calls" (needs a call counter)
- "two concurrent requests converge on one translation" (issue 03)
- "the blinded solver's state cannot contain `diagnosis`" (issue 07)
- "with `TRANSLATION_SANDWICH=false`, no translation node exists in the compiled graph" (issue 08)

This issue only sets up the ground. It does not attempt broad coverage.

## Task

1. Add **vitest** (`vitest`, plus `@vitest/coverage-v8` if you want coverage) as a dev dependency. Vitest is chosen over jest for native ESM and TypeScript path-alias support — this repo is `"type": "module"` with `@/*` → `src/*`.
2. Add `vitest.config.ts` resolving the `@/*` alias to match `tsconfig.json`.
3. Add scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.
4. Place tests beside their subject as `*.test.ts` (e.g. `src/core/graph/03repo/translationStore.test.ts`).
5. Write **one** smoke test that imports a pure module and asserts something trivial, to prove the harness runs. `src/core/graph/utils/prompt.ts` is a good target — it is pure and has no import-time side effects.
6. Add `pnpm test` to `.github/workflows/` if a CI workflow exists.

## Gotcha — import-time side effects

Most modules under `src/core/graph/03repo/` perform filesystem and database work at **module scope**, so importing them in a test opens SQLite and parses YAML:

- `03repo/db.ts:30` `fs.mkdirSync`, `:32` `new DatabaseSync(...)`, `:38` `migrate(...)`
- `03repo/symptoms.repo.ts:38` parses a 2.6 MB JSON file
- `03repo/diagnosis.repo.ts:112`, and the `createTranslationStore(...)` calls at module scope in `procedures.repo.ts`, `anamnesis.repo.ts`, `labels.repo.ts`

Do **not** try to fix that here — issues 01 and 04 move this work behind constructors. For now, write the smoke test against a module with no such imports, and note the constraint in a comment.

## Acceptance criteria

- [ ] `pnpm test` runs and passes
- [ ] The `@/*` alias resolves inside tests
- [ ] The smoke test imports a real source module, not a fixture
- [ ] No test imports anything under `03repo/` (until issue 01 lands)

## Out of scope

Coverage targets, integration tests against a live LLM, the provider contract-test kit (F05).
