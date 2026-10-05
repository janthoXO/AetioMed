# Catalogue data

Every file in this directory is optional. A missing file is treated as an empty one, so the
server starts with an empty `CATALOG_DIR`.

## Licensed data: not in the repository

These files hold UMLS / ICD-11 derived data that we may not redistribute. They are listed
in `.gitignore`. Put your own copies here; never commit them.

| File                        | Shape                                                   | Without it                                                                                           |
| --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `diagnosis.yml`             | `"<ICD>": { code: "<ICD>", names: [primary, ...alts] }` | No ICD lookup: a request must send `diagnosis` (name) as well as `icd`; `GET /api/diagnosis` is `[]` |
| `diagnosisTranslations.yml` | `<Language>: { <English name>: <translated name> }`     | Diagnosis names are LLM-translated on first use, then cached                                         |
| `diagnosis_symptoms.json`   | `{ "<ICD>": { "symptoms": [{ "name": "...", ... }] } }` | No UMLS symptom floor: symptoms are LLM-generated per ICD code, then cached                          |

`diagnosis.yml` and `diagnosisTranslations.yml` can be rebuilt from the ICD-11 API with
`scripts/extract-icd11.ts` and `scripts/extract-icd11-translations.ts`.
