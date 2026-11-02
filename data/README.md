# Catalogue data

Every file in this directory is optional. A missing file is treated as an empty one, so the
server starts with an empty `CATALOG_DIR`.

## Licensed data: not in the repository

These files may hold UMLS / ICD derived or otherwise licensed data that we may not redistribute, so the
repository ships only one-entry samples in `examples/` (copy one here to try it). Put your own copies here
and keep them out of git yourself, e.g. list them in `.git/info/exclude` (local, never pushed); they are
deliberately not in `.gitignore`, so a fork may commit its own.

| File                  | Shape                                   | Without it                                                                                   |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `diagnoses.fhir.json` | FHIR `CodeSystem` of diagnosis names    | Diagnosis names are LLM-translated on first use, then cached. Ignored when ICD is configured |
| `symptoms.fhir.json`  | FHIR `ConceptMap`, ICD code to symptoms | No curated symptoms: symptoms are LLM-generated per ICD code, then cached                    |

Both are FHIR R4 but lenient: every field not listed below is optional or ignored, `resourceType` may be
omitted, and the file may be the bare resource or a `Bundle` (other resource types in it are ignored).

### `diagnoses.fhir.json`

```json
{
  "concept": [
    { "display": "Diarrhea", "designation": [{ "language": "de", "value": "Durchfall" }] }
  ]
}
```

Full form: `{ resourceType: "CodeSystem", language?: "en", content?: "supplement", supplements?: "http://hl7.org/fhir/sid/icd-10", concept: [{ code?, display?, designation?: [{ language?, value }], concept?: [...] }] }`.
`display` is in the CodeSystem's `language` (default `en`), `designation`s carry other languages (`de-CH`
counts as `de`). A concept without an English name is skipped; nested `concept`s are flattened. `code` is unused.

### `symptoms.fhir.json`

```json
{ "group": [{ "element": [{ "code": "1A40", "target": [{ "display": "Diarrhea" }] }] }] }
```

Full form: `{ resourceType: "ConceptMap", status?, group: [{ source?: "<ICD system url>", target?: "<symptom system url>", element: [{ code, display?, target?: [{ code?, display, equivalence?, comment? }] }] }] }`.
The symptom terminology is up to you (e.g. UMLS, SNOMED CT, HPO). `element.code` is matched exactly against the
diagnosis's ICD code; each `target` becomes a symptom (`display` = name, `comment` = description). Targets
without `display`, or with `equivalence` `unmatched` or `disjoint`, are skipped. The same code in several
groups or ConceptMaps is concatenated.

## Procedure catalogue

`procedures.fhir.json` is a FHIR R4 `Bundle` and the only procedure file: CodeSystem concepts form the
category/procedure tree (`display` = English name, `designation` = translations), and an optional
`ObservationDefinition` coded with the CodeSystem `url` + concept code adds reference bands. Without it
procedures are freeform. See
[README-DEV.md](../README-DEV.md#data-files).
