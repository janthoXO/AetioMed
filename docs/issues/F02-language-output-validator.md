# F02 — Language output validator

**Status:** Future work · **Depends on:** 09, 10
**Design ref:** `architecture-target.md` §5.3

## Summary

Verify that generated free text is actually in the target language, and retry once when it is not.

Deferred deliberately: the system-prompt directive (issue 09) plus a localized grammar should be sufficient, and adding a validator before observing drift is speculative work.

## Why it will be cheap when wanted

The n-gram detector added for auto-detection (issue 10) doubles as an output validator. No new dependency, and the `LanguageDetector` port already exists.

## Design sketch

Wrap the free-text path in the LLM port:

1. Generate.
2. Project the result to text (`textOf`, issue 11) and run the detector.
3. If confidence is high **and** the detected language differs from the target, retry once with an intensified directive.
4. On a second mismatch, accept and log a warning — never fail a generation over this.

Apply only to **user-facing** roles. Internal artifacts are English by construction (issue 09), so validating them is either redundant or actively wrong.

## Trigger for picking this up

Observed drift in German output on the deployed model — typically an anamnesis answer that starts in German and finishes in English on longer outputs.

## Notes

Short fields are exactly where n-gram detection is weakest, so set a minimum length below which validation is skipped rather than guessed. A false positive that triggers a needless retry costs a call and may produce a worse answer.
