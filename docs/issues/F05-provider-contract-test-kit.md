# F05 — Provider contract-test kit

**Status:** Future work · **Depends on:** 13, 14
**Design ref:** `architecture-target.md` §10.6

## Summary

A package a third-party provider author runs against their own implementation to prove it satisfies the port contract.

## Why this matters for an open-source project

The ports in this architecture — `MedicalBasisProvider`, modality providers, `ProcedureCatalog`, `LlmPort` — are the extension surface for people who will never read the codebase. Without an executable contract, "implements the interface" means "type-checks", and type-checking does not capture the behavioural obligations: deterministic ordering, `AbortSignal` honouring, the `alt` text guarantee, never throwing on empty input.

**It is cheapest to write while exactly one implementation of each port exists** — the obligations are still visible, and there is no legacy behaviour to reverse-engineer.

## Design sketch

Export a suite per port that a provider author invokes with their implementation:

```ts
import { testMedicalBasisProvider } from "aetiomed/testing";
testMedicalBasisProvider(() => new MyProvider(config));
```

**Obligations to assert, per port:**

| Port                   | Obligations                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MedicalBasisProvider` | returns `[]` rather than throwing when it has nothing; honours `AbortSignal` within a bound; sets `sourceId`/`retrievedAt` on every fragment; is idempotent for the same query; never returns unfenced instruction-shaped text                                      |
| Modality provider      | `render(alt, ctx)` returns a non-empty `Uint8Array` for any non-empty `alt`; the result's MIME type is one it declared in `produces`; is deterministic for the same `alt` where the underlying model allows; honours `AbortSignal`; never inspects or mutates `alt` |
| `ProcedureCatalog`     | `exclude()` is pure and returns a new set; `grammar()` rejects excluded names; `categories()` is stable across calls                                                                                                                                                |
| `LlmPort`              | respects role and temperature; propagates `AbortSignal`; surfaces provider errors as typed errors                                                                                                                                                                   |

## Notes

Ship it as an exported subpath (`aetiomed/testing`) rather than a separate package, at least initially — one version to keep in sync.

This is also the natural home for the assertions issues 13 and 14 already require, so the harness can be extracted from those tests rather than written twice.
