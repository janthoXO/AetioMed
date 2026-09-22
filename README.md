# AetioMed — AI Medical Case Generator for Medical Education

**AetioMed is a self-hostable backend service that uses large language models (LLMs) to generate realistic, internally consistent synthetic patient cases — patient, chief complaint, anamnesis and a blinded diagnostic workup — from an ICD-11 code or diagnosis name, for medical educators and training platforms.**

[![Release](https://img.shields.io/github/v/release/janthoXO/AetioMed)](https://github.com/janthoXO/AetioMed/releases)
[![Build](https://github.com/janthoXO/AetioMed/actions/workflows/build.yml/badge.svg)](https://github.com/janthoXO/AetioMed/actions/workflows/build.yml)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io%2Fjanthoxo%2Faetiomed%2Fserver-blue)](https://github.com/janthoXO/AetioMed/pkgs/container/aetiomed%2Fserver)
![Node.js >= 24.21](https://img.shields.io/badge/node-%3E%3D24.21-brightgreen)

## Table of Contents

1. [What is AetioMed?](#what-is-aetiomed)
2. [Key Features](#key-features)
3. [Use Cases](#use-cases)
4. [How AetioMed Compares](#how-aetiomed-compares)
5. [Quick Start](#quick-start)
6. [Architecture](#architecture)
7. [Generation Pipeline](#generation-pipeline)
   - [Medical Basis](#medical-basis)
   - [Presentation](#presentation)
   - [Procedures](#procedures)
   - [Translation](#translation)
8. [Plan Mode](#plan-mode)
9. [Difficulty Levels](#difficulty-levels)
10. [Design Notes](#design-notes)
11. [FAQ](#faq)
12. [Developer Guide](README-DEV.md)

## What is AetioMed?

AetioMed is a synthetic medical case generator for medical education and clinical reasoning training. Given a diagnosis — an ICD-11 code or a free-text name — it produces a structured virtual patient case: patient demographics, a chief complaint, a patient-voiced anamnesis (medical history), and a step-by-step diagnostic workup with procedure results.

It is built for medical schools, educators, e-learning and virtual-patient platforms, and researchers who need many diverse, consistent practice cases without writing each one by hand. AetioMed is a backend only: it exposes a REST API and a NATS messaging interface, and returns schema-validated JSON that any frontend or learning platform can render.

AetioMed runs with Ollama (fully local, self-hosted models), Google Gemini, or any OpenAI-compatible LLM endpoint. It is built with TypeScript, Node.js, LangChain and LangGraph.

> **Not for clinical use.** AetioMed generates fictional cases for teaching and training. Its output is not medical advice and must not be used for diagnosis or treatment of real patients.

## Key Features

- **Automated Case Generation**: Create detailed medical cases from an ICD-11 code or a diagnosis name.
- **Outline-First Generation**: A single case blueprint is written first and acts as the source of truth for every generated field, so the patient, chief complaint, and anamnesis cannot contradict each other.
- **Blinded Diagnostic Workup**: Procedures are chosen by a solver that does _not_ know the diagnosis, producing a realistic diagnostic pathway rather than a list of tests reverse-engineered from the answer.
- **Difficulty Control**: `easy` / `medium` / `hard` shape how directly the case points at the diagnosis, both in the presentation and in the workup results.
- **Selectable Fields**: Generate any subset of patient, chief complaint, anamnesis, and procedures.
- **Multi-Language**: The supported set is configured per deployment. With the translation sandwich on, generation always happens in English internally and is translated on the way out; with it off, generation runs directly in the target language.
- **Restricted Vocabularies**: When configured, procedure names and anamnesis categories are constrained to an approved, translatable list.
- **Live Progress**: Every pipeline step reports when it starts and finishes, as a short label in the requester's language. A client can fetch the compiled pipeline once and light up its steps as they run, over REST or NATS.
- **Two Integration Styles**: A synchronous REST API that streams the job back on the same request, and an asynchronous NATS interface whose requests and results survive restarts and dropped connections. Every feature is available on both.
- **Plan Mode**: Optionally pause generation once the case outline exists, show it to a human reviewer in the request's own language, and let them approve it, edit it, or ask for an AI revision before the rest of the case is generated.
- **Cancellation and Fair Scheduling**: Any running or queued job can be cancelled from either transport, and one concurrency limit applies to all of them.
- **Operator Observability**: OpenTelemetry traces with each step's timing and output, sent to any OTLP-compatible backend, or printed to the console for local development.
- **Structured Data**: Outputs schema-validated JSON suitable for integration with other educational platforms. Content-bearing fields (`chiefComplaint`, each `anamnesis[].answer`, each `procedures[].result`) are ordered arrays of typed content parts, so a field can carry more than plain text without a schema change.

## Use Cases

- **Medical schools and educators** — generate practice cases for problem-based learning, OSCE preparation, or case-based seminars, at a chosen difficulty.
- **Virtual patient and e-learning platforms** — back an interactive case player with an API that returns structured, schema-validated JSON, with live progress while a case is generated.
- **Clinical reasoning training** — let students work through a diagnostic workup that was ordered by a solver that did not know the answer, including plausible dead ends.
- **Multilingual curricula** — serve the same pipeline in several languages, with controlled vocabularies (procedure names, anamnesis categories) translated from a curated catalogue.
- **Research on AI in medical education** — a reproducible, observable LLM pipeline (LangGraph, OpenTelemetry) for studying generated-case quality across models.

## How AetioMed Compares

|                                             | AetioMed                                        | Prompting a general-purpose chatbot | Static case bank / hand-written vignettes |
| ------------------------------------------- | ----------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| New case per diagnosis on demand            | Yes                                             | Yes                                 | No — fixed set                            |
| Fields consistent with each other           | Yes — all rendered from one judged outline      | Not enforced                        | Yes — checked by the author               |
| Workup chosen without knowing the diagnosis | Yes — blinded solver                            | No                                  | Depends on the author                     |
| Difficulty control                          | `easy` / `medium` / `hard`, enforced by a judge | Prompt-dependent                    | Fixed per case                            |
| Procedures limited to your approved list    | Yes — grammar-constrained                       | No                                  | Not applicable                            |
| Output format                               | Schema-validated JSON                           | Free text, not guaranteed           | Varies                                    |
| Languages                                   | Configurable, with cached translations          | Any, unmanaged                      | Usually one                               |
| Self-hosted, local models                   | Yes — Ollama                                    | Depends on the provider             | Not applicable                            |
| Authoring effort per case                   | None                                            | One prompt per case                 | High                                      |

## Quick Start

Requirements: Docker, and an LLM — an API key for Google Gemini or an OpenAI-compatible endpoint, or a local Ollama.

**1. Get the catalogues and configure an LLM.** The server image does not bundle the catalogue data, so clone the repository for its `data/` directory:

```bash
git clone https://github.com/janthoXO/AetioMed.git
cd AetioMed
cp .env.example .env   # set LLM_PROVIDER, LLM_MODEL and LLM_API_KEY
```

**2. Run the released Docker image:**

```bash
docker run --rm -p 3030:3030 --env-file .env \
  -v "$PWD/data:/app/data" \
  ghcr.io/janthoxo/aetiomed/server:latest
```

To run fully locally instead, set `LLM_PROVIDER=ollama` and `LLM_MODEL=llama3.1` in `.env` and run `docker compose up --build`: it starts the server together with an Ollama container that pulls the model.

**3. Generate a case:**

```bash
curl -X POST http://localhost:3030/api/cases \
  -H 'Content-Type: application/json' \
  -d '{"diagnosis": "Influenza", "difficulty": "easy", "language": "English"}'
```

The response is a JSON case with `patient`, `chiefComplaint`, `anamnesis` and `procedures`. Send `Accept: text/event-stream` to receive live progress events on the same request. See the [Developer Guide](README-DEV.md) for every configuration option, the full REST and NATS APIs, and local development setup.

## Architecture

AetioMed is a single backend service: a generation engine at the centre, with two ways in.

```
        REST (synchronous, streaming)            NATS (asynchronous, durable)
                    │                                        │
                    └─────────────┐              ┌───────────┘
                                  ▼              ▼
                          ┌──────────────────────────────┐
                          │   Case generation service    │  one entry point: validation,
                          │   (job ids, concurrency,     │  language, job lifecycle,
                          │    cancellation, results)    │  errors — for both transports
                          └──────────────┬───────────────┘
                                         ▼
                          ┌──────────────────────────────┐
                          │   LangGraph pipeline         │  medical basis → presentation
                          │                              │  → procedures (→ translation)
                          └──────────────┬───────────────┘
                                         │ node started / finished
                          ┌──────────────┴───────────────┐
                          ▼                              ▼
                 Progress labels                   OpenTelemetry
                 (end user, live)                  (operator, analysis)
```

**One engine, two transports, full parity.** Every product feature — submitting a case,
watching its progress, receiving the result, cancelling it, reading the catalogues and the
pipeline structure — is available over both REST and NATS. A client can speak only one of
them and lose nothing. What differs is only what each protocol can promise:

|                               | REST                                         | NATS                                         |
| ----------------------------- | -------------------------------------------- | -------------------------------------------- |
| Style                         | synchronous — one call, streamed back        | asynchronous — fire a request, collect later |
| Progress                      | live on the same response, or a watch stream | a progress subject per job                   |
| Survives a dropped connection | no — disconnecting cancels the job           | yes — requests and results are persisted     |
| Result retrievable later      | no                                           | yes, for an hour                             |

REST suits an interactive client that waits for its case; NATS suits a worker fleet, batch
jobs, or anything that must not lose work to a network hiccup. When both are enabled, REST
uses NATS as its backbone, so a REST client can watch or cancel a job running on any server
in the deployment.

**Progress and telemetry are separate channels.** End users get short, localized progress
labels — _"Generating case outline"_, _"Choosing next procedure"_ — for every step as it
starts and finishes, always on. Operators get OpenTelemetry: a span per step with timing and
metadata, and the step's actual output as a correlated log record, exported to whatever
observability backend the deployment already runs. Neither channel depends on the other.

**Bounded, cancellable work.** One concurrency limit applies across both transports, so
throughput doesn't depend on which door a request came in through; excess requests queue,
and a queued or running job can be cancelled at any time. Resubmitting a job id never starts
a second generation.

**Deployable to its needs.** Each transport is switched on by a flag, so a deployment can be
an HTTP API, a NATS worker with no HTTP surface, or both. There is no plugin system — every
component is constructed explicitly at startup, in a fixed order.

See the [Developer Guide](README-DEV.md) for the module layout, the APIs and the design rules.

## Generation Pipeline

All AI generation runs as a **LangGraph** state machine, assembled from the deployer's flags at boot. With the translation sandwich enabled the top-level graph is:

```
[translate diagnosis + instructions → English] → [case generation] → [translate case → target language]
```

With it disabled the translation phases are **not compiled into the graph at all**, and generation runs directly in the target language. Within a compiled graph, whether a given request is translated is still decided per request — a deployment that _can_ translate does not translate an English request.

The case-generation phase runs up to three stages: **medical basis → presentation → procedures**.

The full compiled graph is in [`docs/graphs/case-graph.translation-sandwich.svg`](docs/graphs/case-graph.translation-sandwich.svg) (sandwich on) and [`docs/graphs/case-graph.none.svg`](docs/graphs/case-graph.none.svg) (sandwich off).

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

Progress labels are localized too, falling back to English for any step without a translation.

Every LLM-generated translation is persisted with `source: "generated"`, distinguishing it from a clinician-reviewed YAML row (`source: "curated"`), so generated terms can be reviewed and promoted into the curated YAML files. Determinism holds **per deployment**, not across deployments — a fresh install can generate a different German term for the same English source than an existing one did, since nothing forces two independent LLM calls to agree. If cross-deployment stability is ever needed, the answer is curated YAML, not better locking.

## Plan Mode

By default (`mode: "normal"`) a case generates end to end with no human in the loop. Setting
`"mode": "plan"` in the request pauses generation once the outline exists and returns it for
review, in the request's own language, before anything else is generated.

**REST** — `POST /api/cases` with `"mode": "plan"` stops instead of returning a finished case:
`202` with a JSON body (or, over `Accept: text/event-stream`, an `event: review`) carrying the
outline as an array of editable/fixed segments, a `revision` number, and an expiry. The reviewer
answers with `POST /api/cases/:jobId/review`:

```bash
curl -X POST http://localhost:3030/api/cases \
  -H 'Content-Type: application/json' \
  -d '{"diagnosis": "Influenza", "mode": "plan", "language": "German"}'
# → 202 {"jobId": "...", "status": "awaiting_review", "review": {"revision": 1, "outline": [...], ...}}

curl -X POST http://localhost:3030/api/cases/<jobId>/review \
  -H 'Content-Type: application/json' \
  -d '{"revision": 1, "decision": {"action": "approve"}}'
# → 200, the finished case (or another 202 if the reviewer asked for a revision)
```

A decision is one of `approve` (generate from the outline as shown), `edit` (submit the same
segment array with only its editable text changed — the segment count and every fixed section
must stay exactly as shown), or `revise` (ask the AI to regenerate the outline from written
feedback; not re-judged automatically, and bounded by a configurable round limit). A paused job
can also be read back with `GET /api/cases/:jobId/review`. With `ALLOW_LLMS`, a decision may also carry an
`llmConfig`; it replaces the one the job was started with for the rest of the job.

**NATS** — the same round trip, asynchronous: a plan-mode `cases.request.generate` publishes its
pause to `cases.review.<jobId>` instead of `cases.result.<jobId>`, and a decision is a
request/reply on `cases.decision.<jobId>`, answered by the replica running the job. Both modes
still finish on `cases.result.<jobId>`.

A paused job survives a restart and waits out a configurable time limit
(`REVIEW_TTL_MINUTES`) before it is abandoned. See the [Developer Guide](README-DEV.md) for the
full outline segment format and every status code.

## Difficulty Levels

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

## FAQ

### What is AetioMed?

AetioMed is a self-hostable, LLM-based generator of synthetic medical cases for medical education. It turns an ICD-11 code or diagnosis name into a structured virtual patient case: patient, chief complaint, anamnesis, and a diagnostic workup with results.

### Does AetioMed use real patient data?

No. Cases are fictional. The inputs are a diagnosis plus curated catalogues shipped in `data/` — an ICD-11 diagnosis list, a UMLS-derived symptom list, and approved procedure and anamnesis-category lists. No patient records are needed or stored.

### Which LLMs does AetioMed support?

Ollama, Google Gemini, and any OpenAI-compatible endpoint. The generator, judge and translator roles can each use a different model, and a deployment can let each request choose a model from an allowlist.

### Can AetioMed run locally without a cloud LLM?

Yes. With Ollama as the provider, the whole pipeline runs self-hosted. `docker compose up --build` starts the server with an Ollama container (see [Quick Start](#quick-start)).

### Which languages does AetioMed support?

The deployer configures the language set (`LANGUAGES`, default `English,German`). English is always included. Cases are either generated in English and translated, or generated directly in the target language.

### Does AetioMed include a user interface?

No. AetioMed is a backend service with a REST API (with Server-Sent Events streaming) and a NATS interface. Any frontend, LMS or virtual-patient player can consume its JSON output.

### Can AetioMed be used for clinical decision support?

No. AetioMed is for teaching and training only. Its cases are fictional and its output is not medical advice.

## Developer Guide

For technical documentation, installation instructions, and contribution guidelines, please refer to the **[Developer Guide](README-DEV.md)**.
