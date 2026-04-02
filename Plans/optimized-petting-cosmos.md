# Plan: Restructure vslsp to Vertical Slices + Add MCP Server

## Context

vslsp is a C# diagnostics suite for AI agents that now has two capabilities: LSP diagnostics (via OmniSharp) and code structure mapping (via Roslyn/CodeMapper). The current layout is horizontal (flat `src/` with `commands/`), which creates artificial coupling. CodeMapper was just ingested from a separate repo and sits as a shelled-out binary.

The goal: restructure into vertical slices so each capability owns its full stack, then add an MCP server entry point so any MCP-aware editor (Claude Code, Cursor, VS Code) can auto-discover and use these tools without CLI knowledge.

## Target Structure

```
vslsp.ts                          # CLI entry point (unchanged interface)
mcp.ts                            # MCP server entry point (new, stdio transport)

src/
  core/
    types.ts                      # Shared types (from src/types.ts)
    lsp-client.ts                 # OmniSharp process mgmt (from src/lsp-client.ts)
    defaults.ts                   # Default paths + port (extracted from vslsp.ts)

  diagnostics/
    collector.ts                  # One-shot collection (from src/diagnostics.ts)
    store.ts                      # Stateful accumulator (from src/diagnostics-store.ts)
    daemon.ts                     # Daemon lifecycle (from src/commands/serve.ts)
    http.ts                       # Daemon HTTP API (from src/http-server.ts)
    client.ts                     # HTTP client: query + notify + status (merges query.ts + notify.ts)

  code-mapping/
    mapper.ts                     # Spawn CodeMapper binary (from src/commands/map.ts)

tools/code-mapper/                # C# Roslyn project (unchanged)
```

## Migration Steps

### Step 1: Create directory structure + move files
Move files with renames, no behavioral changes:
- `src/types.ts` -> `src/core/types.ts`
- `src/lsp-client.ts` -> `src/core/lsp-client.ts`
- Extract defaults from `vslsp.ts` -> `src/core/defaults.ts`
- `src/diagnostics.ts` -> `src/diagnostics/collector.ts`
- `src/diagnostics-store.ts` -> `src/diagnostics/store.ts`
- `src/commands/serve.ts` -> `src/diagnostics/daemon.ts`
- `src/http-server.ts` -> `src/diagnostics/http.ts`
- `src/commands/query.ts` + `src/commands/notify.ts` -> `src/diagnostics/client.ts`
- `src/commands/map.ts` -> `src/code-mapping/mapper.ts`

### Step 2: Update all import paths
Fix imports in every moved file. No behavioral changes.

### Step 3: Update vslsp.ts imports
Point CLI entry point at new locations. Same interface, same output.

### Step 4: Refactor slice functions for data return
Currently `query()`, `notify()`, `map()` call `process.exit()` and `console.log()` directly. Refactor them to return data. Move I/O to the CLI entry point. This is required for MCP to work (MCP handlers can't call `process.exit()`).

Key changes:
- `client.ts`: `query()` returns parsed JSON object, `notify()` returns response
- `mapper.ts`: capture CodeMapper stdout instead of `stdout: "inherit"`, return string
- `collector.ts`: already returns `DiagnosticsResult` (no change)
- `daemon.ts`: stays as long-running; MCP will spawn it as detached subprocess

### Step 5: Add MCP server entry point
New file `mcp.ts`. Dependencies: `@modelcontextprotocol/sdk`, `zod`.

MCP tools to register:

| Tool | Description | Delegates to |
|------|-------------|-------------|
| `get_diagnostics` | Get C# compilation diagnostics | `collector.collect()` or `client.query()` if daemon running |
| `get_diagnostics_summary` | Get error/warning counts | `collector.collect()` (summary only) or `client.query({summary: true})` |
| `get_code_structure` | Map C# code structure | `mapper.map()` |
| `start_daemon` | Start persistent diagnostics server | spawn `vslsp serve` as detached subprocess |
| `get_daemon_status` | Check if daemon is running | `client.status()` |

### Step 6: Wire up build + install
- Add `bun build mcp.ts --compile --outfile vslsp-mcp` to build
- Install both binaries to `~/.local/share/vslsp/`
- Add `.mcp.json` example for Claude Code configuration

### Step 7: Clean up
- Remove empty `src/commands/` directory
- Remove old file locations

## Files to Modify

| Current File | Action | New Location |
|---|---|---|
| `src/types.ts` | Move | `src/core/types.ts` |
| `src/lsp-client.ts` | Move | `src/core/lsp-client.ts` |
| `src/diagnostics.ts` | Move + rename | `src/diagnostics/collector.ts` |
| `src/diagnostics-store.ts` | Move + rename | `src/diagnostics/store.ts` |
| `src/http-server.ts` | Move + rename | `src/diagnostics/http.ts` |
| `src/commands/serve.ts` | Move + rename | `src/diagnostics/daemon.ts` |
| `src/commands/query.ts` | Merge into | `src/diagnostics/client.ts` |
| `src/commands/notify.ts` | Merge into | `src/diagnostics/client.ts` |
| `src/commands/map.ts` | Move + rename + refactor | `src/code-mapping/mapper.ts` |
| `vslsp.ts` | Update imports + move I/O here | (same) |
| `mcp.ts` | **New** | MCP server entry point |
| `package.json` | Add `@modelcontextprotocol/sdk`, `zod` | (same) |
| `src/core/defaults.ts` | **New** | Extracted constants |

## Dependency Graph

```
vslsp.ts ──┐                    ┌── mcp.ts
           │                    │
           ├── core/defaults ───┤
           │                    │
           ├── diagnostics/ ────┤
           │   collector ──> core/lsp-client, core/types
           │   daemon ────> core/lsp-client, store, http
           │   http ──────> core/lsp-client, store
           │   client ────> (fetch only, no internal deps)
           │   store ─────> core/types
           │                    │
           └── code-mapping/ ───┘
               mapper ────> core/defaults (path only)
```

No circular dependencies. Slices never import from each other. Core never imports from slices.

## Verification

1. **CLI parity**: `vslsp --help` output unchanged. Run `vslsp --solution X.sln`, `vslsp map .`, `vslsp serve/query/notify/status` — all produce identical output to current version.
2. **MCP server**: `echo '{"jsonrpc":"2.0","method":"initialize",...}' | vslsp-mcp` responds with tool list. Configure in `.mcp.json` and verify Claude Code discovers the tools.
3. **Build**: `bun build vslsp.ts --compile` and `bun build mcp.ts --compile` both succeed.
4. **Type check**: `bun run tsc --noEmit` passes.
