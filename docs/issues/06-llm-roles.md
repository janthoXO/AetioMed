# 06 — LLM roles: generator, judge, translator

**Depends on:** 04 · **Blocks:** 09
**Design ref:** `architecture-target.md` §10.5, §5.1

## Why

Generators and judges are the same model today, which is the pipeline's structural blind spot: a model that thinks a case is subtle will also judge it subtle. Role separation is the cheapest fix, and it enables the configuration that works in practice — a small local model generating, a stronger model judging, since judging is a fraction of call volume.

It is also the axis **language** travels on (design §5.1): internal roles always emit English, user-facing roles emit the target language. Issue 09 depends on roles existing.

## Task

### 1. Env pairs

```
LLM_PROVIDER / LLM_MODEL / LLM_API_KEY / LLM_URL / LLM_TEMPERATURE   # general fallback
LLM_GENERATOR_PROVIDER  / LLM_GENERATOR_MODEL  / …                   # optional
LLM_JUDGE_PROVIDER      / LLM_JUDGE_MODEL      / …                   # optional
LLM_TRANSLATOR_PROVIDER / LLM_TRANSLATOR_MODEL / …                   # optional
```

Each role falls back **per field**, not per role: an unset `LLM_JUDGE_TEMPERATURE` takes the general temperature even when `LLM_JUDGE_MODEL` is set. Validate at startup and print the resolved triple per role.

### 2. Role assignment

| Role | Call sites |
|---|---|
| `generator` | `case.aigateway.ts` (plan), `patient/chiefComplaint/anamnesis.aigateway.ts`, `procedures.aigateway.ts` blinded step, result step, bridge |
| `judge` | `outlineEvaluation.aigateway.ts`, `matchDiagnosis` in `procedures.aigateway.ts:1567` |
| `translator` | `diagnosis.aigateway.ts`, `translate.helper.ts`, catalog LLM fill (issue 03) |

### 3. Port shape

Role sits on the `LlmPort` from issue 04, alongside the existing temperature split (`getLLM` / `getDeterministicLLM` / `getCreativeLLM`). Both dimensions belong on the port:

```ts
runtime.llm.for({ role: "judge", temperature: "deterministic" })
```

Do not add a fourth global factory function per role — that is 12 combinations of copy-paste.

### 4. Per-request `llmConfig` still wins

`ALLOW_LLMS` lets a request supply `llmConfig`. Decide and document: a request-supplied config applies to **all roles** (simplest, and matches today's semantics). Per-role overrides in the request body are out of scope.

## Acceptance criteria

- [ ] With only the general LLM configured, all three roles resolve to it
- [ ] With `LLM_JUDGE_*` set, judge calls use it and generator calls do not — assert with a fake port recording `(role, model)`
- [ ] Startup prints the resolved provider/model/temperature per role
- [ ] Per-field fallback works: `LLM_JUDGE_MODEL` set without `LLM_JUDGE_TEMPERATURE` inherits the general temperature
- [ ] `getSearchTool` and the other dead exports in `utils/llm.ts` are gone (if not already removed in 05)

## Out of scope

Language binding per role (09). Cost/token accounting per role — worth doing later on the same seam.
