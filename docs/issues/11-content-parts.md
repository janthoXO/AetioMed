# 11 — Content parts

**Depends on:** 05 · **Blocks:** 12, 13
**Design ref:** `architecture-target.md` §11.1, §11.2

## Why

Every field that can be multimodal becomes an ordered array of typed parts. Modality providers need not be LLMs — an image model reached over MCP returns bytes — so `byte[]` is the one return type that unifies them.

This is a **breaking schema change**. Do it in one release, together with F08 (schema versioning), before third parties consume the API.

## Current state

| Field                 | Today        | File                         |
| --------------------- | ------------ | ---------------------------- |
| `chiefComplaint`      | `z.string()` | `models/ChiefComplaint.ts:3` |
| `anamnesis[].answer`  | `z.string()` | `models/Anamnesis.ts:9`      |
| `procedures[].result` | `z.string()` | `models/Procedure.ts:43`     |

`CaseSchema` (`models/Case.ts:10-15`) currently plays four roles at once — LLM output schema, HTTP response body, Redis payload, and translation input/output. That coupling is what makes content changes expensive.

## Task

### 1. The type

```ts
type ContentPart = {
  type: string;        // MIME type
  value: Uint8Array;   // the rendered artifact
  alt: string;         // plain text: what this part conveys
};

ProcedureResult = { name, relevance, result: ContentPart[] }
AnamnesisField  = { category, answer: ContentPart[] }
ChiefComplaint  = ContentPart[]
```

**`alt` is the render request, retained** — the plain-text input the provider was called with (issue 13), not a description the provider produced. Every part therefore carries text **by construction**: there is no provider obligation to enforce and nothing to validate at startup.

**Semantics: additive parts, all rendered.** The array is an ordered list of parts that together _compose_ one field value. It is **not** a list of alternative renditions to choose between. Put this in the schema docstring — it is the kind of ambiguity that produces two clients that disagree.

```
result = [
  { type: "text/plain", alt: "Chest X-ray, PA. Consolidation …",        value: <utf8 of alt> },
  { type: "image/png",  alt: "PA chest radiograph, right lower lobe …", value: <bytes> },
  { type: "text/plain", alt: "Impression: right lower lobe pneumonia.", value: <utf8 of alt> },
]
```

Two consequences: **order is meaningful** and must survive the modality fan-in, persistence and translation; and **an empty array is not a valid field value** — a field that exists has at least one part, a field that does not exist is absent.

### 2. Text parts: `value` is derived, not authored

For a `text/*` part the rendering is the words themselves, so `value = utf8(alt)`. Model it as a **derived** field. That is what makes the uniform shape safe:

| Property                                                           | Consequence                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `textOf()` is `parts.map(p => p.alt).join("\n\n")`                 | no `isText()` branch in any consumer                             |
| Translation touches `alt` only, then re-derives `value` (issue 12) | the two **cannot** drift, because one is computed from the other |
| "every part contributes text" is a property of the type            | nothing to validate, nothing a provider can get wrong            |

Provide a single constructor so `value` is never hand-assembled:

```ts
const textPart = (alt: string): ContentPart => ({
  type: "text/plain",
  alt,
  value: new TextEncoder().encode(alt),
});
```

Do **not** make `alt` optional-and-absent for text parts. It avoids storing the string twice but forces every consumer to branch and re-introduces two translation paths; the duplication is only apparent, since one side is computed.

### 3. Split the LLM schema from the domain schema

The LLM must **never** be asked to emit `Uint8Array` or base64 — small models cannot do it reliably, and a corrupted blob is not a schema violation, so the retry loop cannot catch it.

Field generators keep producing ordinary strings under `z.string()` schemas; that text becomes the canonical text and then the `alt` of each render request (issue 13). Separate `CaseSchema` (domain) from the per-generator LLM output schemas — they are no longer the same object. `CaseSchema` currently plays four roles at once (LLM output, HTTP body, Redis payload, translation input/output), and that coupling is what makes content changes expensive.

### 4. Wire encoding

`value` serializes to a JSON **string**, encoded by MIME class:

| MIME            | Encoding        |
| --------------- | --------------- |
| `text/*`        | UTF-8, verbatim |
| everything else | base64          |

Omit `alt` on the wire for `text/*` parts — it is derivable from `value`, and the deserializer fills it back in. Uniform in the domain, no duplication on the wire.

Put the serializer in **one** place; it is a boundary concern, not a domain concern. A round trip must be lossless and order-preserving.

**Size ceiling.** Inline base64 inflates by ~33% and the whole case is held in memory, persisted and returned in one response. Enforce a configurable maximum part size and **fail loudly** above it rather than silently shipping a 20 MB document. An asset store is the eventual answer and is additive — `type` already governs interpretation — so leave a `TODO` naming the threshold rather than building it now.

### 5. `textOf()` — the only path from content to a prompt

```ts
const textOf = (parts: ContentPart[]) => parts.map((p) => p.alt).join("\n\n");
```

Consumers: the plan prompt, the plan judge, `matchDiagnosis`, logs and traces, and above all the presentation slice handed to the **blinded solver** (`03procedure/index.ts:66` `presentationOf`, and `previousProcedures` at `:238`), which re-reads it on every one of up to six iterations.

Enforce in the type system: prompt builders take `string`, never `ContentPart[]`. **Bytes must never reach a prompt.**

### 6. Migration of persisted cases

Existing Redis-persisted cases (if any survive issue 05) have string fields. Either write a read-time upgrade (`string` → `[{type:"text/plain", value}]`) or accept the break and document it. Given the persistency extension is deleted in issue 05, accepting the break is probably right — confirm before assuming.

## Acceptance criteria

- [ ] The three fields are `ContentPart[]` with a required `alt`; the docstring states additive-parts semantics and the non-empty rule
- [ ] `textPart()` is the only place `value` is derived from `alt` for text parts
- [ ] No LLM output schema mentions bytes or base64 — `grep -rn "base64" src/core/graph/03aigateway/` returns nothing
- [ ] `textOf` exists in one place and is `parts.map(p => p.alt)` — no MIME branching
- [ ] A prompt builder given `ContentPart[]` does not type-check
- [ ] Test: a mixed text/image/text array round-trips serialize → deserialize unchanged, order preserved
- [ ] Test: `text/*` serializes to a readable UTF-8 string, not base64; `image/png` serializes to base64
- [ ] Test: `alt` is omitted on the wire for text parts and restored on deserialize
- [ ] Test: a part exceeding the size ceiling fails with a clear error naming the field and size
- [ ] `CaseSchema` is no longer used directly as an LLM output schema

## Out of scope

The modality registry and providers (13), the translation split (12), an asset store (record the threshold and defer).
