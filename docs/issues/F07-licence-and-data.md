# F07 — Licence and data redistribution

**Status:** Future work — **blocking for public release** · **Depends on:** nothing
**Design ref:** `architecture-target.md` §10.1, §10.3

## Summary

Two questions that must be answered before the repository is published, and neither is a code change.

## 1. There is no LICENSE file

Without one, the default is "all rights reserved" and nobody can legally use it. The choice is deliberate:

|                | Effect                                                                        |
| -------------- | ----------------------------------------------------------------------------- |
| **MIT**        | Maximum adoption, minimum obligation                                          |
| **Apache-2.0** | Same, plus an explicit patent grant — institutional legal teams look for this |
| **AGPL-3.0**   | A hospital running it as a hosted service must publish its modifications      |

For university-originated medical software intended for institutional deployment, Apache-2.0 is the common choice; AGPL matters if contributions-back are a goal. Also settle contributor terms (a CLA or DCO) at the same time.

## 2. Bundled ICD-11 and UMLS-derived data

`data/` currently contains, committed to the repository:

| File                        | Size    | Derived from |
| --------------------------- | ------- | ------------ |
| `diagnosis.yml`             | ~2.5 MB | ICD-11 (WHO) |
| `diagnosisTranslations.yml` | ~3.1 MB | ICD-11       |
| `diagnosis_symptoms.json`   | ~2.6 MB | UMLS         |

Both sources carry terms governing redistribution of derived content, and UMLS access is individually licensed per user. **This needs checking with someone qualified before publication, not after.**

**The likely resolution is already half-built.** `scripts/extract-icd11*.ts` exists. Ship the extraction scripts plus a documented ingestion step, and let a deployer generate the corpora from their own licensed access. That also makes the catalogs deployer-replaceable, which issue 02 wants anyway — so the licensing fix and the deployability fix are the same change.

## Acceptance criteria

- [ ] `LICENSE` present and referenced from `README.md` and `package.json`
- [ ] Redistribution terms for both data sources confirmed in writing
- [ ] If redistribution is not permitted: corpora removed from git history (not merely deleted), extraction documented, and first-run behaviour without them is a clear error rather than a crash
- [ ] `NOTICE` or `THIRD-PARTY.md` attributing data sources and their terms

## Notes

Removing large files from git history is disruptive and gets harder with every clone. If the answer is likely to be "cannot redistribute", resolve it **before** the repository goes public rather than after.
