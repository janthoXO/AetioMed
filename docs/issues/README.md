# Issues

One file per development step, derived from `docs/architecture-target.md` §13.

Each issue is written to be handed to a coding agent together with **`docs/architecture-target.md`** and the repository. Read the design document first — the issues reference its sections rather than restating them.

## Implementation

| #   | Issue                                                                              | Depends on     | Behaviour change?                |
| --- | ---------------------------------------------------------------------------------- | -------------- | -------------------------------- |
| 00  | [Test infrastructure](00-test-infrastructure.md)                                   | —              | no                               |
| 01  | [Catalog module and ports](01-catalog-ports.md)                                    | 00             | no                               |
| 02  | [Catalog config and startup validation](02-catalog-config-and-validation.md)       | 01             | yes — fails fast on bad catalogs |
| 03  | [Translation store: provenance, locking, retries](03-translation-store-locking.md) | 01             | yes — fixes a determinism bug    |
| 04  | [Graph runtime and port bundle](04-graph-runtime-and-ports.md)                     | 01             | no                               |
| 05  | [Delete the extension system](05-delete-extension-system.md)                       | 04             | yes — removes endpoints          |
| 06  | [LLM roles](06-llm-roles.md)                                                       | 04             | no                               |
| 07  | [ProcedureStrategy port](07-procedure-strategy.md)                                 | 04             | no                               |
| 08  | [Graph assembly from flags](08-graph-assembly.md)                                  | 05, 07         | no                               |
| 09  | [Language binding](09-language-binding.md)                                         | 02, 03, 06, 08 | yes                              |
| 10  | [Language detection](10-language-detection.md)                                     | 09             | yes — new capability             |
| 11  | [Content parts](11-content-parts.md)                                               | 05             | yes — schema change              |
| 12  | [Translation split](12-translation-split.md)                                       | 09, 11         | yes — fixes an overwrite bug     |
| 13  | [Presentation subgraphs and modality](13-presentation-subgraphs.md)                | 11             | yes — new capability             |
| 14  | [Medical basis registry](14-medical-basis-registry.md)                             | 04             | no                               |
| 15  | [Node-bound tracing and labels](15-node-bound-tracing-otel.md)                     | 05, 08         | yes — new capability             |
| 16  | [Localized candidate grammars](16-localized-candidate-grammars.md)                 | 09             | yes — new capability             |

**Hard ordering constraints:** 01–03 before everything; 04 before 06–09; 11 before 12 and 13.

## Future work

| #   | Issue                                                                                |
| --- | ------------------------------------------------------------------------------------ |
| F01 | [Human-in-the-loop](F01-human-in-the-loop.md) — see also `docs/human-in-the-loop.md` |
| F02 | [Language output validator](F02-language-output-validator.md)                        |
| F03 | [Medical-basis decision node](F03-medical-basis-decision-node.md)                    |
| F04 | [Evaluation harness](F04-evaluation-harness.md)                                      |
| F05 | [Provider contract-test kit](F05-provider-contract-test-kit.md)                      |
| F06 | [MCP provider adapter](F06-mcp-provider-adapter.md)                                  |
| F07 | [Licence and data redistribution](F07-licence-and-data.md)                           |
| F08 | [Case schema versioning](F08-case-schema-versioning.md)                              |
| F09 | [Checkpointing and crash resumption](F09-checkpointing.md)                           |

## Conventions for issue authors

- Reference code as `path/to/file.ts:LINE`.
- State acceptance criteria as checkboxes that a reviewer can verify without running a generation where possible.
- Put anything that changes a public contract (HTTP shape, env var, YAML format) under its own heading — those need release notes.
