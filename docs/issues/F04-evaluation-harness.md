# F04 — Evaluation harness

**Status:** Future work · **Depends on:** 04, 06, 08
**Design ref:** `architecture-target.md` §10.6; `engineering-review.md` §6.4

## Summary

A harness that runs a fixed set of diagnoses through the pipeline and scores the output, so prompt and model changes stop being guesswork.

`engineering-review.md` calls this the highest-value missing piece, and it is right: judges and generators are the same model family, so the pipeline structurally cannot detect its own systematic blind spots. This is also the only thing that gives regression protection when a deployer changes `LLM_MODEL`.

## Why the target architecture makes it cheap

Once the graph is assembled from ports (issue 04) with a role-based LLM port (issue 06), **the harness is just another assembly**: the same graph, a recording LLM port, fixed catalogs, a seed set. It needs no production code changes — which is worth stating as a design goal rather than discovering as a happy accident.

## Design sketch

**Corpus:** ~20 diagnoses spanning ICD chapters × three difficulties. Committed as YAML.

**Three scoring layers, cheapest first:**

1. **Code checks** — no LLM, run always:
   - diagnosis-name leak: case-insensitive word-boundary search for `diagnosis.name` and `alternativeNames` in the plan and in every generated field. This is the single most embarrassing failure mode and it is a string search.
   - biometric plausibility: age/height/weight ranges.
   - schema completeness: every flagged field present and non-empty.
   - procedure names all drawn from the catalogue.
2. **Solver metrics** — free ground truth already computed by the pipeline: `solverIterationsUsed` and `bridged: boolean`. A case solved on iteration 1 is too easy; one that exhausts six and needs the bridge may be incoherent. This measures *actual solvability* rather than a model's opinion of it, so it is more trustworthy than the obviousness judge. Record it on the result even before the harness exists.
3. **Model grader** — a strong cloud model scoring clinical coherence and difficulty fit. Optional, and the only layer that costs money.

**Output:** a per-run report and a diff against the previous run, so a prompt change shows as a delta.

## Notes

Layer 1 is worth building even without the rest — it is deterministic, free, and catches the worst failures. `engineering-review.md` §4.2 argues these checks should also run *inline* ahead of the LLM judges, not only in the harness.
