# 10 — Language detection

**Depends on:** 09 · **Blocks:** nothing
**Design ref:** `architecture-target.md` §5.4

## Why

A caller should be able to omit `language` and have the request resolve sensibly. Detection belongs to the **communication layer**, not the graph: its output _selects the ports_, and binding happens before invoke — so a detection node inside the graph could not inform the thing its answer is for. It is also request normalisation, sitting naturally beside the ICD→name resolution already in the transport.

## Task

### 1. The ladder

```
1. language explicitly provided       → use it                      (no cost)
2. deterministic n-gram detector      → use it if above threshold   (no cost, offline)
3. LLM fallback, only if enabled      → one cheap call              (rare, opt-in)
4. otherwise                          → configured default          (English)
```

`LANGUAGE_AUTO_DETECT` enables steps 2–3; step 3 additionally requires an explicit opt-in so a deployer does not pay LLM calls unknowingly. This is **not** a graph flag and must not add a compiled variant.

### 2. Detect on `userInstructions`, never the diagnosis name

Two decisive reasons:

- When a request supplies only `icd`, the diagnosis name is resolved from **our own English catalogue** — detecting on it is circular.
- Diagnosis names are 2–3 words and frequently Latin. _"Diabetes mellitus"_ is byte-identical in English, German and Spanish.

`userInstructions` is the only request field with enough free text. If it is absent or shorter than a minimum length (~30 characters is a reasonable floor for n-gram detection), skip straight to step 4.

### 3. Library

Use a small offline n-gram detector — `franc`, `tinyld` or `eld`. Requirements: no network, works on short text, exposes a confidence score. Wrap it behind a `LanguageDetector` port so it can be faked in tests and swapped later.

### 4. Extensibility

The supported set comes from config (issue 09). The ladder must degrade honestly:

- Startup validates that every configured language has a catalog translation file, and **warns** for any the detector library does not support.
- A language the detector cannot recognise simply never wins step 2 — it remains fully usable when passed explicitly at step 1. **Detection is a convenience, never a gate.**
- Map detector output (ISO codes) to configured language names in one place.

### 5. Echo the resolved language

Include the resolved language in the response so a client can notice a wrong guess and retry explicitly. Treat detection as a hint with a confidence threshold, not an authority.

## Acceptance criteria

- [ ] Explicit `language` always wins; the detector is not invoked
- [ ] With `userInstructions` absent, the default is used and no detector call happens
- [ ] German instructions resolve to German; below-threshold confidence falls to the default
- [ ] The diagnosis name is never passed to the detector — assert with a spy
- [ ] A configured language unsupported by the detector still works when passed explicitly, and warns at startup
- [ ] The response echoes the resolved language
- [ ] No new compiled graph variant

## Out of scope

Validating that generated output is actually in the target language — F02.
