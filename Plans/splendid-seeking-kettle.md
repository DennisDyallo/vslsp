# Plan: Implement vslsp Proposal Gaps (P0–P2)

## Context

An Engineer subagent used vslsp during a real debugging session and reported 4 gaps
(docs/vslsp-proposals.md). P3 is deferred. This plan addresses P0–P2:

- **P0** — `get_code_structure` drops private/protected members (visibility filter)
- **P1** — No `find_symbol` (workspace symbol search)
- **P2** — No `find_usages` (find references / call chain tracing)

These gaps force agents to fall back to grep for navigation tasks that OmniSharp
already supports. Tool count goes from 8 → 10.

---

## Phase 1: P0 — Visibility parameter for `get_code_structure`

**Standalone, no daemon dependency. Lowest effort, highest impact.**

### Files to modify

| File | Change |
|------|--------|
| `tools/csharp-mapper/Program.cs` | Add `--visibility` CLI arg (`all` \| `public`). Store as `bool filterVisibility` on `StructureCollector`. Gate all 9 `IsPublicOrInternal()` call sites with `if (filterVisibility && ...)` |
| `src/code-mapping/mapper.ts` | Add `visibility` to `MapOptions`, push `--visibility <val>` to subprocess args |
| `mcp.ts` | Add `visibility: z.enum(["all","public"]).optional().default("public")` to `get_code_structure` schema. Pass through to `map()` |

### Verify

- `bun run tsc --noEmit` clean
- Rebuild CSharpMapper: `dotnet publish tools/csharp-mapper/CSharpMapper.csproj -c Release -r osx-arm64 -p:PublishSingleFile=true --self-contained true`
- Call `get_code_structure({ path, visibility: "all" })` on a project with internal sealed classes → private methods appear
- Call with default → private methods absent (no regression)

---

## Phase 2: P1 — `find_symbol` (workspace/symbol)

**New MCP tool. 4-layer pattern: LSP client → HTTP server → HTTP client → MCP tool.**

### Files to modify

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `SymbolResult` interface, `symbolKindToString()` helper |
| `src/core/lsp-client.ts` | Add `workspaceSymbol(query)` method via `this.connection.sendRequest("workspace/symbol", { query })`. Declare `workspace.symbol` capability in `initialize()` |
| `src/diagnostics/http.ts` | Add `GET /symbol?query=X&kind=Y` endpoint. Transform LSP `SymbolInformation` → `SymbolResult[]`, filter by kind |
| `src/diagnostics/client.ts` | Add `findSymbol(port, query, kind?)` function |
| `mcp.ts` | Register `find_symbol` tool. Schema: `{ query, kind?, port? }`. Requires running daemon |

### Input/Output

```
Input:  { query: "WaitForReadyToReadAsync", kind?: "method" }
Output: { symbols: [{ name, kind, file, line, column, containerName? }], count }
```

### Risk: Large result sets

Add `limit` param (default 50) to prevent context overflow on short queries.

### Verify

- Start daemon → `find_symbol({ query: "Program" })` returns results with file paths and line numbers

---

## Phase 3: P2 — `find_usages` (textDocument/references)

**Depends on Phase 2** (symbol-name convenience path chains through `findSymbol`).

### Files to modify

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `UsageLocation`, `UsageResult` interfaces |
| `src/core/lsp-client.ts` | Add `references(uri, line, column)` method via `textDocument/references`. Call `didOpen` first (required by OmniSharp). Declare `textDocument.references` capability |
| `src/diagnostics/http.ts` | Add `GET /references?file=X&line=Y&column=Z` endpoint |
| `src/diagnostics/client.ts` | Add `findUsages({ port, file, line, column })` function |
| `mcp.ts` | Register `find_usages` tool. Two input modes: precise (`file+line+column`) or convenience (`symbol` name, resolves via `findSymbol` first) |

### Input/Output

```
// Precise
Input:  { file: "/path/File.cs", line: 151, column: 52 }
// Convenience
Input:  { symbol: "WaitForReadyToReadAsync" }

Output: { definition: { file, line }, usages: [{ file, line, column, context? }], count }
```

### Verify

- Start daemon → `find_usages({ symbol: "Main" })` returns definition + usage locations

---

## Phase 4: Documentation and metadata

| File | Change |
|------|--------|
| `CLAUDE.md` | Update tool count 8→10, add `find_symbol`/`find_usages` to MCP Tool Reference, add `visibility` to `get_code_structure` docs |
| `mcp.ts` | Verify version string bump |
| `package.json` | Bump version to 1.8.0 |

---

## Dependency Graph

```
Phase 1 (visibility) ──────────────────────────────┐
                                                    ├──→ Phase 4 (docs)
Phase 2 (find_symbol) → Phase 3 (find_usages) ─────┘
```

Phase 1 and Phase 2 can execute in parallel.

---

## Final Verification Checklist

- [ ] `bun run tsc --noEmit` — clean
- [ ] `grep -c "registerTool" mcp.ts` — returns 10
- [ ] `get_code_structure` with `visibility: "all"` shows private members
- [ ] `find_symbol` returns symbols with file+line from running daemon
- [ ] `find_usages` returns references from running daemon
- [ ] CLAUDE.md tool count updated to 10
