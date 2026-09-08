# 02 — Catalog configuration and startup validation

**Depends on:** 01 · **Blocks:** 09
**Design ref:** `architecture-target.md` §7.2, §7.3, §7.4

## Why

Two deployability defects. There are **11 hardcoded `data/*.yml` paths** resolved against `process.cwd()`, so a deployer's only way to supply their own catalogues is to mount a volume over `data/` — which also clobbers `data/cache/`, where the SQLite database lives. And a bad translation key currently exits with a message that does not always name the offending key.

## Current state — every hardcoded path

```
03repo/labels.repo.ts:13        data/labelTranslations.yml
03repo/diagnosis.repo.ts:25     data/diagnosisTranslations.yml
03repo/diagnosis.repo.ts:64     data/diagnosis.yml
03repo/procedures.repo.ts:22    data/proceduresTranslations.yml
03repo/procedures.repo.ts:57    data/procedures.yml
03repo/procedures.repo.ts:110   data/proceduresTranslations.yml
03repo/anamnesis.repo.ts:22     data/anamnesisCategoriesTranslations.yml
03repo/anamnesis.repo.ts:63     data/anamnesisCategories.yml
03repo/anamnesis.repo.ts:119    data/anamnesisCategoriesTranslations.yml
03repo/symptoms.repo.ts:18      data/diagnosis_symptoms.json
03repo/db.ts:29                 data/cache            ← output, not input
```

## Task

### 1. Two directories, not one

```
CATALOG_DIR   default "data"        # input:  read-only, deployer-owned
CACHE_DIR     default "data/cache"  # output: writable, generated
```

Every path above except `db.ts:29` resolves against `CATALOG_DIR`; `db.ts:29` resolves against `CACHE_DIR`. Defaults preserve today's layout, so existing deployments keep working.

Resolve both **once**, in one module, and have the repos take a resolved absolute path. Do not scatter `path.resolve(process.cwd(), ...)` calls.

### 2. Fail-fast validation, naming the offending key

Applies to **every** catalogue including labels (design §7.2 — one rule, uniformly). On a translation key absent from the base catalogue, exit non-zero with:

```
[labels] data/labelTranslations.yml declares a key absent from the catalogue.
         Unknown key:  "Choosing next procedur" (German)
         Did you mean: "Choosing next procedure"?
```

- Name the **catalogue**, the **file**, the **key** and the **language**.
- Report **all** offending keys, not just the first — a deployer fixing a typo should not have to restart four times.
- The near-match suggestion is a plain Levenshtein over the base catalogue, suggested only when distance ≤ 3. Do not add a dependency for this; it is ~20 lines.

### 3. Startup summary

Print, per catalogue: entry count, configured languages, and how many keys have translations vs fall back. This is the smallest useful version of the `--print-config` idea in design §3 and makes misconfiguration obvious.

## Behaviour change — note in release notes

A typo in any translation file now **prevents startup**. That is deliberate (design §7.2), and the named-key output makes the fix immediate. Flag it: a deployer editing labels in production can brick a restart.

## Acceptance criteria

- [ ] `CATALOG_DIR` and `CACHE_DIR` are read in exactly one place and threaded from there
- [ ] `grep -rn '"data/' src/` returns nothing
- [ ] Pointing `CATALOG_DIR` at a copied directory works; pointing `CACHE_DIR` elsewhere puts the SQLite file there
- [ ] A deliberately corrupted translation key exits non-zero and prints catalogue, file, key, language and a suggestion
- [ ] Multiple bad keys are all reported in one run
- [ ] Tests cover the validator as a pure function over `(baseKeys, translationKeys)` — no filesystem needed

## Out of scope

A full config file (design §3 keeps env-only), `--print-config` as a separate CLI mode.
