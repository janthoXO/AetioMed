# F06 — MCP provider adapter

**Status:** Future work · **Depends on:** 13, 14
**Design ref:** `architecture-target.md` §9

## Summary

Let a deployer add a medical-basis or modality provider by pointing configuration at an MCP server, with no fork and no TypeScript.

## Why this is the right plugin axis

The deleted extension system plugged in at the **module** axis — internal components shipped in the same repo, written by the same people, importing each other directly. That axis needed a composition root, not a plugin system.

The axis that genuinely wants third-party plugins is the **port** axis: medical-basis providers, modality providers, catalog sources, LLM providers. MCP fits it naturally, and `utils/tool.ts:5` already states the ambition — the existing `Tool<TInput, TOutput>` shape (`name`, `description`, `inputSchema`, `invoke`) is deliberately MCP-shaped.

## Design sketch

An adapter implementing the in-process port by calling an MCP server:

```
providers:
  - id: uptodate
    transport: mcp
    command: ["npx", "some-uptodate-mcp"]
    produces: ["text/markdown"]
    trust: external
```

**What MCP gives you:** process isolation, language-agnostic providers (a Python scraper needs no TypeScript), and an existing ecosystem.

**What it does not give you:** applicability metadata. Discovery returns name, description and JSON schema — nothing about when a provider is relevant. So selection stays config-declared alongside the server entry. *MCP is the right transport boundary and the wrong selection mechanism.*

## Requirements

- **Zero cost when unconfigured.** Gate on `servers.length === 0` *before* the handshake, or every boot pays a connect and `tools/list` for nothing.
- **Trust boundary.** External provider content is fenced and provenance-tagged (issue 14 §5). An MCP server is a third-party process whose output lands in the plan prompt.
- **Failure isolation.** A server down at boot and one that dies mid-run need different handling; neither may fail a generation.
- **Credentials.** A deployer needs somewhere to put API keys that is not the provider manifest in version control.
- **Timeouts.** Per-provider, bounded by the request `AbortSignal`.

## Notes

Config likely outgrows flat env vars at this point — this is the trigger for moving to the optional config file that `architecture-target.md` §3 keeps as alternative B.
