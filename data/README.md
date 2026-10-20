# Catalogue data

Every file in this directory is optional. A missing file is treated as an empty one, so the
server starts with an empty `CATALOG_DIR`.

## Licensed data: not in the repository

These files hold UMLS / ICD-11 derived data that we may not redistribute. They are listed
in `.gitignore`. Put your own copies here; never commit them.

| File                        | Shape                                                   | Without it                                                                                           |
| --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `diagnosisTranslations.yml` | `<lang-code>: { <English name>: <translated name> }`    | Diagnosis names are LLM-translated on first use, then cached. Ignored when ICD is configured          |
| `diagnosis_symptoms.json`   | `{ "<ICD>": { "symptoms": [{ "name": "...", ... }] } }` | No UMLS symptom floor: symptoms are LLM-generated per ICD code, then cached                          |
