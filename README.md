# AetioMed

Welcome to AetioMed!

## Introduction

AetioMed is an advanced system designed to generate synthetic medical cases for educational and training purposes. By leveraging state-of-the-art Artificial Intelligence (Large Language Models), AetioMed creates realistic patient scenarios, including detailed anamnesis (medical history), chief complaints, and a full diagnostic workup.

This tool aims to support medical educators and institutions in creating diverse and consistent training materials, ensuring high-quality resources for students and professionals.

## Table of Contents

1. [Introduction](#introduction)
2. [Features](#features)
3. [Architecture](#architecture)
4. [Generation Pipeline](#generation-pipeline)
   - [Medical Basis](#medical-basis)
   - [Presentation](#presentation)
   - [Procedures](#procedures)
   - [Translation](#translation)
5. [Difficulty](#difficulty)
6. [Design Notes](#design-notes)
7. [Developer Guide](README-DEV.md)

## Features

- **Automated Case Generation**: Create detailed medical cases from an ICD-11 code or a diagnosis name.
- **Outline-First Generation**: A single case blueprint is written first and acts as the source of truth for every generated field, so the patient, chief complaint, and anamnesis cannot contradict each other.
- **Blinded Diagnostic Workup**: Procedures are chosen by a solver that does _not_ know the diagnosis, producing a realistic diagnostic pathway rather than a list of tests reverse-engineered from the answer.
- **Difficulty Control**: `easy` / `medium` / `hard` shape how directly the case points at the diagnosis, both in the presentation and in the workup results.
- **Selectable Fields**: Generate any subset of patient, chief complaint, anamnesis, and procedures.
- **Multi-Language**: The supported set is configured per deployment. With the translation sandwich on, generation always happens in English internally and is translated on the way out; with it off, generation runs directly in the target language.
- **Restricted Vocabularies**: When configured, procedure names and anamnesis categories are constrained to an approved, translatable list.
- **Live Tracing**: Per-job progress streamed over SSE while a case is generated — localized step labels for an end user, node-bound structured traces for an operator, and `GET /api/graph` so a client can render the compiled pipeline and light up nodes as they run. OpenTelemetry spans are exported in parallel.
- **Structured Data**: Outputs schema-validated JSON suitable for integration with other educational platforms. Content-bearing fields (`chiefComplaint`, each `anamnesis[].answer`, each `procedures[].result`) are ordered arrays of typed content parts, so a field can carry more than plain text without a schema change.

## Architecture

The server is a small core plus a set of modules started explicitly from one
composition root. `createApp()` (`src/core/app.ts`) parses the feature flags,
builds the event bus, the graph and the case-generation service, and then
starts each transport whose flag is set. There is no plugin loader, no
auto-discovery and no dependency resolution — the startup order is the order
the code is written in.

The core owns three things: the case-generation graph, a typed `EventBus`,
and `CaseGenerationService`. Everything else — the HTTP API
(`src/transports/rest/`), the NATS worker (`src/transports/nats/`), and
tracing (`src/tracing/`) — is an ordinary module with a start function.

**`CaseGenerationService` is the seam both transports call.** It owns ICD→name
resolution, language resolution, job ids, generation-flag normalisation and
terminal events; the routers and the NATS handler are protocol translation
only. This is what lets a deployment be reduced to just what it needs: an
HTTP-only instance, a NATS worker with no HTTP surface, or a bare generator
with neither.

**Communication is one-way.** The graph emits lifecycle events — `Node
Started`, `Node Completed`, `Node Failed`, `Generation Log` — onto the bus,
and `CaseGenerationService` emits the terminal ones (`Generation Completed`,
`Generation Failure`, `Generation Cancelled`). Modules subscribe. Nothing a
subscriber does can influence how a case is generated.

See the [Developer Guide](README-DEV.md) for the module layout.

## Generation Pipeline

All AI generation runs as a **LangGraph** state machine, assembled from the deployer's flags at boot. With the translation sandwich enabled the top-level graph is:

```
[translate diagnosis + instructions → English] → [case generation] → [translate case → target language]
```

With it disabled the translation phases are **not compiled into the graph at all**, and generation runs directly in the target language. Within a compiled graph, whether a given request is translated is still decided per request — a deployment that _can_ translate does not translate an English request.

The case-generation phase runs up to three stages: **medical basis → presentation → procedures**.

### Medical Basis

Establishes the disease knowledge the plan may draw from. This is a registry of providers rather than a fixed step: with no providers registered the node is not compiled in at all, and with one or more, all of them run and their fragments are concatenated in registry order. No LLM call is ever spent deciding which source to use.

The UMLS symptom provider is the first and, today, only entry:

1. A static **UMLS symptom floor** is looked up for the diagnosis's ICD-11 code. This is a curated, non-AI baseline.
2. The floor is passed to the LLM as an exclusion list, which then generates _additional_ plausible symptoms.
3. The generated additions are cached per ICD code with a TTL. A fresh cache hit skips the LLM call entirely, so repeated generations for the same diagnosis start faster and stay consistent.

The result is the union of the static floor and the (cached) LLM additions.

### Presentation

This stage produces the patient, chief complaint, and anamnesis — whichever were requested.

1. **Outline generation.** A single structured markdown blueprint is written containing the complete factual record of the case: exact age/gender/height/weight, the selected symptom subset with onset and timeline, the concrete chief complaint, per-category anamnesis facts, and a _Workup / Procedure Results Strategy_ section describing how later lab and imaging results should be shaped. The diagnosis is never named anywhere in it.

2. **Evaluate ⇄ revise loop.** A judge scores the outline on two dimensions in a single call:
   - _Obviousness_ — does it give the diagnosis away more directly than the requested difficulty permits?
   - _Clinical consistency_ — is the diagnosis kept secret, do the planned fields cohere, are the values physically realistic?

   On rejection, the concrete reasons plus one actionable directive are fed back into a regeneration, and the outline is re-judged. The loop is capped; on exhaustion the current outline is accepted as-is so generation always terminates.

3. **Fan-out.** Once accepted, the outline is sent in parallel to the enabled field generators. Each one only **re-renders the outline's facts** in the right voice and format — the patient generator adds nothing but a plausible name, the chief complaint is rewritten in clinical-chart voice, the anamnesis is rewritten in the patient's own subjective voice for each intake category. None of them invent clinical facts.

Because all consistency judgment happens on the blueprint _before_ any field is written, there is no post-generation consistency repair step. Fields that all derive from one accepted source of truth cannot disagree.

### Procedures

Only runs when the `procedures` flag is set. This is a **blinded solver loop**, and the blinding is the point: it produces a workup that a real clinician might plausibly have ordered, including dead ends, instead of the tidy confirmatory sequence a model produces when it already knows the answer.

The loop has three steps:

1. **Blinded step.** A simulated attending physician sees _only_ the patient presentation and the results of procedures ordered so far. It never sees the diagnosis. It either orders the next batch of mutually independent procedures, or commits to a diagnosis. It is given its remaining step budget as explicit pressure to converge rather than order exhaustively.

2. **Result step.** Knowing the true diagnosis _and_ the outline's workup strategy, this generates realistic results for the ordered batch, plus a `relevance` judgment (`obligatory` / `optional` / `contraindicated`) measured against the true diagnosis. Relevance is deliberately decided here and never by the blinded solver — the solver cannot judge whether a test was contraindicated for a diagnosis it doesn't know. Results then flow back to the blinded step.

3. **Diagnosis check.** When the solver commits, an LLM judge decides whether the proposed name is equivalent to the true diagnosis, accounting for synonyms and abbreviations. On a match, the workup is done. On a mismatch, the wrong guess is recorded as ruled-out and the loop continues.

4. **Bridge.** If the solver exhausts its budget without arriving at the diagnosis, a final non-blinded step generates the remaining confirmatory procedures that complete the pathway, so every case ends with a workup that actually supports its diagnosis.

Two properties are enforced structurally rather than by asking the model nicely: already-ordered procedures are removed from the candidate list before each pick, so duplicate orders are impossible; and when an approved procedure list is configured, the model is constrained to exact names from it.

**Small-model support.** When the approved list is large and categorized, the candidate set can overwhelm a smaller model. `PROCEDURE_PRESELECTION` selects a different procedure-selection _strategy_ at assembly time: instead of one call against the full list, each pick becomes a category pick (deliberately over-inclusive) followed by a procedure pick scoped to those categories. The scoped pick may ask to pull in more categories if nothing in scope fits, under a hard cap. The graph shape is fixed at three nodes either way — the flag swaps an adapter, not a topology.

### Translation

Generation always runs in English — prompts, restricted vocabularies, and clinical reasoning are all English-native — and translation brackets the pipeline on both sides:

- **Inbound**: a caller-supplied diagnosis name and any user instructions are translated to English before anything else runs. This is triggered by _provenance_ — did the caller actually supply free text? — not by the language alone, so an ICD-only request is never "translated" from a name our own catalogue produced.
- **Outbound**: two passes over **disjoint** field sets run in parallel and are combined by a single merge step. The _defined_ pass resolves anamnesis category names and procedure names from the catalogue; the _rest_ pass sends only free-text content through the LLM. Because the sets are disjoint and only the merge writes the result, free-text output can never overwrite the controlled vocabulary.

Translations are cache-aside. Known terms come from YAML translation files; anything missing is translated once by the LLM and persisted, so the same term is never paid for twice. The free-text pass is keyed by a stable field path, so a dropped or reordered entry is detected rather than silently mismatching, and binary content never enters a translation prompt at all.

Trace step labels are translated too, warmed once up front so live progress events can be localized without slowing the pipeline.

Every LLM-generated translation is persisted with `source: "generated"`, distinguishing it from a clinician-reviewed YAML row (`source: "curated"`), so generated terms can be reviewed and promoted into the curated YAML files. Determinism holds **per deployment**, not across deployments — a fresh install can generate a different German term for the same English source than an existing one did, since nothing forces two independent LLM calls to agree. If cross-deployment stability is ever needed, the answer is curated YAML, not better locking.

## Difficulty

Difficulty (`easy` | `medium` | `hard`, default `medium`) is not a post-hoc filter — it is threaded through outline generation, outline evaluation, and workup results:

|            | Symptoms                                                                      | Workup results                                                     |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **easy**   | A clear, classic subset of hallmark symptoms. No distractors.                 | Definitive and textbook.                                           |
| **medium** | Hallmark subset plus 1–2 distractors from a plausible differential.           | Minor or borderline deviations, not immediately conclusive.        |
| **hard**   | Atypical: one or more hallmark symptoms omitted, several distractors present. | Ambiguous, consistent with the diagnosis only on careful analysis. |

The outline judge holds the blueprint to the matching standard, so an "easy-looking" hard case is rejected and revised rather than shipped.

## Design Notes

Approaches that were tried and replaced, kept here so the reasoning isn't relitigated:

**Per-field generation and refinement.** Fields were originally generated one at a time, each with its own chain-of-thought, with earlier fields passed along as context; a refinement pass then patched inconsistencies. The motivation was persona control and clean JSON structure. It was replaced by outline-first generation because independently generated fields drift, and refining after the fact means repairing contradictions instead of preventing them. Persona and structure turned out not to need per-field isolation — a generator rewriting a fixed set of facts holds a voice just as well.

**Post-fan-out consistency checking.** A consistency judge originally ran over the assembled fields. It was moved onto the outline, before any field exists. Judging the blueprint is cheaper, catches problems earlier, and makes the check meaningful: fields rendered from one accepted blueprint have nothing left to disagree about.

**Non-blinded procedure generation.** Generating the workup with knowledge of the diagnosis produced unrealistically direct test sequences — exactly the confirmatory pathway a student is supposed to _derive_. Blinding the solver and generating results separately restores plausible clinical reasoning, including the occasional unhelpful test.

**Explicit chain-of-thought steps.** Separate CoT-generation steps for non-thinking models were dropped in favor of provider-level reasoning control and prompts that carry their own structure.

## Developer Guide

For technical documentation, installation instructions, and contribution guidelines, please refer to the **[Developer Guide](README-DEV.md)**.
