# 13 — Presentation subgraphs and the modality registry

**Depends on:** 11 · **Blocks:** nothing
**Design ref:** `architecture-target.md` §6.4

## Why

Multimodal output needs a place to live. Each presentation field acquires internal control flow — generate content, decide which renderings, run them, fan in — which is exactly when a field earns its own subgraph.

## Current state

`02graphs/02case-generation/02presentation/generation/index.ts`:

- `buildFieldGenerationSends` (`:85-126`) emits one `Send` per enabled field with the payload `{ diagnosis, outline, userInstructions }` — **already narrow and uniform across all three fields**. That uniformity is the seam; preserve it.
- `patient_generate`, `chief_complaint_generate`, `anamnesis_generate` are single-node function nodes.
- `case_fan_in` (`:395-402`) is `passthrough`; accumulation happens via the `case` reducer's shallow merge.

A compiled subgraph **is** a valid `Send` target, so swapping a function-node for a subgraph-node is a one-line change per field.

## Task

### 1. One subgraph per field

`patientGraph`, `chiefComplaintGraph`, `anamnesisGraph`. Each takes the existing uniform payload and returns `ContentPart[]` (issue 11).

Resist adding a payload field that only one generator needs — that is precisely what destroys the seam.

### 2. Internal shape — generation and rendering are separate

```
Send payload → generate_content ──→ decide_modality ──┬─ provider A ─┐
                (LLM → canonical      (registry;      ├─ provider B ─┼→ fan_in → ContentPart[]
                 text)                 >1 entry only) └─ provider C ─┘
```

1. **`generate_content` always runs.** It produces the field's canonical text — exactly what the field generators do today, under an ordinary `z.string()` schema. It is **not** a modality provider and is **not** registry-gated.
2. **`decide_modality` plans a composition:** an ordered list of render requests, each `{ modality, alt }`, where `alt` is plain text describing what that part should convey — _"an image of a broken right leg"_.
3. **Each provider is called with its `alt`** and returns bytes. A provider renders text into a modality; it never describes its own output.
4. **Each resulting part retains the `alt` it was rendered from** (issue 11).

### 3. The provider interface

```ts
interface ModalityProvider {
  readonly id: string;
  readonly produces: string[]; // MIME types it can emit
  render(alt: string, ctx: RenderContext): Promise<Uint8Array>;
}
```

No LLM assumption anywhere in it. The **text provider** is the degenerate case — `utf8(alt)` — and makes no model call at all, because the text was already produced by `generate_content`. An image provider might call a diffusion model over MCP. Both satisfy the same interface, which is the entire point of the byte carrier.

### 4. The registry

Entries declare which **MIME types** they produce. **Text is a normal registry entry**, not an implicit floor:

| Registry size | Behaviour                                                      |
| ------------- | -------------------------------------------------------------- |
| 0             | Misconfiguration — **reject at startup**                       |
| 1             | That provider runs directly. **No decide node is compiled in** |
| >1            | A decide node is compiled in and plans the composition         |

The decide node's presence is a **compile-time** decision driven by registry size, matching the absent-flag-⇒-absent-node rule of issue 08.

**An image-only registry is safe.** This was a live concern in an earlier revision and is resolved by construction: `generate_content` still runs, every part still carries `alt`, and `textOf()` still returns prose — so the plan judge, `matchDiagnosis` and above all the **blinded solver** (which re-reads `previousProcedures` on every one of up to six iterations) all keep working. The registry controls only _which renderings are emitted_, never _whether text exists_. There is no provider obligation to validate.

### 5. Fan-in ordering

Parts are **additive and ordered** (issue 11), so the fan-in needs a deterministic ordering rule: **the order `decide_modality` planned them in**, not completion order. Otherwise the same configuration produces different field content run to run and evaluation becomes meaningless.

## Acceptance criteria

- [ ] Each field is a compiled subgraph reached by `Send`; the payload is unchanged and uniform
- [ ] `generate_content` runs unconditionally and is not a registry entry
- [ ] Test: with a single-entry registry, the compiled subgraph contains **no** `decide_modality` node
- [ ] Test: with two entries, it does
- [ ] Test: an empty registry fails at startup with a named error
- [ ] Test: an **image-only** registry still yields a non-empty `textOf()` for every field, and a blinded-solver step still receives prose
- [ ] Test: every emitted `ContentPart` has a non-empty `alt`, under every registry configuration
- [ ] Test: fan-in order follows the planned order, not completion order (assert with staggered fake providers)
- [ ] Test: a fake non-LLM provider (`render: async alt => encode(alt)`) works end to end
- [ ] The text provider makes no LLM call
- [ ] Trace events fire per field subgraph

## Known limitation — record, do not fix here

Realization runs **inside** the field subgraph, i.e. **before** translate-out. With the sandwich on, a modality is rendered from an **English** `alt` and its bytes are not translated (only `alt` is — issue 12). Images are mostly fine; burnt-in annotations, speech and audio are not.

The migration path stays open because `generate_content`, `decide_modality` and the providers are **distinct nodes**: when this matters, rendering moves to a post-translation phase and the planning stays put. Keep them separate — that is what makes it a move rather than a rewrite. Add a comment in the subgraph saying so.

## Out of scope

Actual image or audio providers, an asset store, post-translation rendering.
