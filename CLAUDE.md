# vslsp — Agent Reference

MCP server version: **1.9.0** | Tools: **10** | Languages: C#, Rust, TypeScript

---

## Agent Quick-Start

### Step 1 — check for errors first

Before reading code, check if the project has existing errors. For C#:

```
get_diagnostics_summary({ solution: "/abs/path/Project.sln", use_daemon: true })
→ { errors: N, warnings: N, ... }   ← small, fast, tells you whether to worry
```

For Rust/TypeScript, `get_diagnostics` IS the summary (already compact when clean).

### Step 2 — check if your changes compile (C# only: use verify_changes)

| Language | Pre-write check | Post-write check |
|----------|----------------|-----------------|
| **C#** | `verify_changes` (daemon required) | `get_diagnostics({ solution, severity: "error", limit: 20, use_daemon: true, settle_ms: 3000 })` |
| **Rust** | — (no dry-run) | `get_diagnostics({ manifest, severity: "error" })` |
| **TypeScript** | — (no dry-run) | `get_diagnostics({ project, severity: "error" })` |

> **Avoiding stale diagnostics:** After writing files, always pass `settle_ms: 3000` to `notify_file_changed` or `get_diagnostics` (daemon mode). Without it, the LSP server may not have finished reanalyzing and you'll get stale results.

### Step 3 — understand unfamiliar code (use sparingly, always filter)

`get_code_structure` returns full AST output — filter it or it will be enormous.

```
get_code_structure({ path: "/path/to/project", depth: "signatures", max_files: 20 })
```

Use `depth: "signatures"` (types + method names, ~10x smaller than `full`).
Use `file_filter: "src/Core/**"` to scope to a subtree.
Always pass `language:` explicitly for directories — auto-detection can fall back silently.

### AX Philosophy

All tool responses are designed to fit within an agent's context window. See `docs/AX.md` for the complete AX constitution, budget thresholds, and extension checklist.

---

## C# Workflow (Full)

The C# daemon enables **dry-run compilation** — check whether edits compile *before writing to disk*.

```
1. start_daemon({ solution: "/abs/path/to/Project.sln" })
2. poll get_daemon_status() until ready === true  ← takes 10–90s on first run
3. verify_changes({ changes: [{ file: "/abs/path/File.cs", content: "..." }] })
   → returns DiagnosticsResult + verified_files; reverted: true means changes were not kept
4. If clean: write files to disk
5. notify_file_changed({ file: "/abs/path/File.cs", settle_ms: 3000 }) for each written file
6. get_diagnostics({ solution: "/abs/path/Project.sln", use_daemon: true }) to confirm final state
```

> **verify_changes requires a running, ready daemon.** If you skip steps 1–2, it will error. The daemon persists across calls — you only need to start it once per session.

**Polling pattern:**
```
loop:
  result = get_daemon_status()
  if result.ready === true → proceed
  if result.status === "error" → something went wrong, check OmniSharp
  wait and retry (daemon typically ready in 15–60s, up to 90s for large solutions)
```

**verify_changes payload:**
```json
{
  "changes": [
    { "file": "/absolute/path/to/File.cs", "content": "full file content as string" },
    { "file": "/absolute/path/to/Other.cs", "content": "..." }
  ],
  "settle_ms": 3000,
  "timeout_ms": 30000
}
```

The daemon applies changes in-memory, waits `settle_ms` for diagnostics to stabilize, then reverts. Your disk is never touched.

**notify_file_changed:**
- With `content`: in-memory update (daemon uses the provided string, does not read disk)
- Without `content`: daemon reads the file from disk

---

## Rust Workflow

```
1. get_code_structure({ path: "/path/to/crate" })   ← understand layout
2. start_daemon({ manifest: "/path/to/Cargo.toml" })  ← optional: enables find_symbol/find_usages
3. poll get_daemon_status({ port: 7852 }) until ready === true
4. find_symbol({ query: "MyStruct", port: 7852 })   ← find definitions
5. find_usages({ symbol: "MyStruct", port: 7852 })  ← find all references
6. Edit files on disk
7. get_diagnostics({ manifest: "/path/to/Cargo.toml" })
```

`manifest` can be the path to `Cargo.toml` or the directory containing it.

Optional params: `package` (workspace member name), `file` (filter to one file), `all_targets` (include tests/benches).

---

## TypeScript Workflow

```
1. get_code_structure({ path: "/path/to/project" })   ← understand layout
2. start_daemon({ project: "/path/to/tsconfig.json" })  ← optional: enables find_symbol/find_usages
3. poll get_daemon_status({ port: 7851 }) until ready === true
4. find_symbol({ query: "MyClass", port: 7851 })     ← find definitions
5. find_usages({ symbol: "MyClass", port: 7851 })    ← find all references
6. Edit files on disk
7. get_diagnostics({ project: "/path/to/tsconfig.json" })
```

`project` can be the path to `tsconfig.json` or the directory containing it. Optional `file` param filters to one file.

---

## If a Mapper Binary Is Missing

When `get_code_structure` reports "binary not found", install the mapper:

```bash
vslsp install-mapper csharp      # C# / Roslyn
vslsp install-mapper rust        # Rust / syn
vslsp install-mapper typescript  # TypeScript / TS Compiler API
```

This downloads only that one binary for the current platform and version. Nothing else is touched.

---

## MCP Tool Reference

### Diagnostics (all languages)

```
get_diagnostics(solution | manifest | project, file?, severity?, limit?, ...)
  → DiagnosticsResult
  Provide exactly one of:
    solution: C# — absolute path to .sln file
    manifest: Rust — path to Cargo.toml or directory containing one
    project:  TypeScript — path to tsconfig.json or directory containing one
  file:     filter to a single source file (all languages)
  severity: "error" | "warning" | "info" | "hint" — minimum severity to include
            "error" = errors only; "warning" = errors + warnings; default: all
  limit:    max total diagnostics to return (e.g. 20). Applied after severity filter.

  C#-only: timeout?, quiet_period?, use_daemon?, port?, settle_ms?
  settle_ms: daemon only — wait for diagnostics to stabilize (2000–3000 after writes)
  Rust-only: package?, all_targets?

get_diagnostics_summary(solution | manifest | project, use_daemon?, port?, settle_ms?)
  → { errors, warnings, info, hints }
  Call this first — tiny response, tells you whether to run full diagnostics.
  With use_daemon: works for all languages. One-shot: C# only.

start_daemon(solution | manifest | project, port?)
  → { status, port, solution, ready }
  Provide exactly one of:
    solution: C# — absolute path to .sln file
    manifest: Rust — path to Cargo.toml
    project:  TypeScript — path to tsconfig.json
  Port defaults: C#=7850, TypeScript=7851, Rust=7852

get_daemon_status(port?)             → { status, ready, updateCount, solution }
stop_daemon(port?)                   → { status, port }

notify_file_changed(file, content?, settle_ms?, port?)
  → { ok, file }   content = in-memory update; omit to read from disk
  settle_ms: wait for diagnostics to stabilize (2000–3000 recommended after writes)

verify_changes(changes[{file, content}], settle_ms?, timeout_ms?, port?)
  → DiagnosticsResult + { verified_files, reverted: true }
  REQUIRES: running daemon with ready: true. Disk is never written.
```

### Code Structure

```
get_code_structure(path, language?, depth?, file_filter?, max_files?, format?, visibility?)
  → { summary, files, warning? }
  path:        directory or single file — always pass language: for directories
  language:    "csharp" | "rust" | "typescript" — auto-detected if omitted
               WARNING: auto-detection may silently return 0 files; prefer explicit
  depth:       "signatures" (default) | "types" | "full" (opt-in, single files only)
               "types"      — type names only, no methods (~50x smaller than full)
               "signatures" — types + method signatures, no children (~10x smaller)
               "full"       — complete recursive output (use only for single files)
  file_filter: glob pattern — e.g. "src/Core/**", "**/*.service.ts"
  max_files:   cap results at N files — use 10–20 for an overview
  format:      "json" (default) | "text" | "yaml" — ignored when filters are set
  visibility:  "public" (default) | "all" — C# only
               "public"  — public/internal members only (API surface)
               "all"     — includes private/protected — use for debugging internal classes
```

### Navigation (all languages — requires running daemon)

```
find_symbol(query, kind?, limit?, port?)
  → { symbols: [{ name, kind, file, line, column, containerName? }], count }
  query:  symbol name or partial name to search for
  kind:   "class" | "method" | "interface" | "field" | "property" | "enum" | "struct" | "all"
  limit:  max results (default: 50)
  REQUIRES: running daemon (call start_daemon first, poll until ready)

find_usages(file?, line?, column?, symbol?, port?)
  → { definition?: { file, line, column }, usages: [{ file, line, column }], count }
  Provide either:
    file + line + column — precise lookup
    symbol              — convenience; resolves via find_symbol first
  REQUIRES: running daemon (call start_daemon first, poll until ready)
```

---

## DiagnosticsResult Schema

```typescript
{
  solution: string,          // path to .sln or Cargo.toml
  timestamp: string,         // ISO 8601
  summary: { errors: number, warnings: number, info: number, hints: number },
  clean: boolean,            // true = no errors
  files: [{
    uri: string,
    path: string,
    diagnostics: [{
      severity: "error" | "warning" | "info" | "hint",
      line: number,          // 1-indexed
      column: number,        // 1-indexed
      endLine: number,
      endColumn: number,
      message: string,
      code: string,          // "CS1002", "E0596", "TS2304", etc.
      source: string,        // "csharp", "rustc", or "tsc"
    }]
  }]
}
```

---

## Code Structure Member Schema

Every member always emits all fields (no nulls):

```typescript
{
  type: "Class"|"Struct"|"Enum"|"Variant"|"Field"|"Property"|"Method"|"Const"|
        "Constructor"|"Record"|"Interface"|"Trait"|"Impl"|"Fn"|"Mod"|"Namespace"|"Type",
  signature: string,         // includes visibility + modifiers verbatim
  lineNumber: number,
  isStatic: boolean,
  visibility: "public"|"private"|"internal"|"protected"|"protected internal"|"crate"|"restricted(path)",
  docString: string,         // "" if none
  baseTypes: string[],       // [] if none
  attributes: string[],      // [] if none
  children: CodeMember[],    // struct fields, enum variants, nested types
}
```

---

## Constraints

- `verify_changes` requires a running daemon — call `start_daemon` first, poll `get_daemon_status` until `ready: true`
- `notify_file_changed` with `content` does in-memory update (no disk read); without `content` reads from disk
- All mappers (CSharpMapper, RustMapper, TSMapper) are opt-in; install with `vslsp install-mapper <lang>`
- Daemon default port: `7850` (see `src/core/defaults.ts`)
- Daemon binds to `127.0.0.1` only — not accessible from LAN
- OmniSharp requires .NET 6.0+; `cargo` must be in PATH for Rust; `tsc`/`bunx` required for TS diagnostics
- Paths passed to all tools must be **absolute** — relative paths are not supported

---

## Installed Binaries

| Binary | Path |
|--------|------|
| CLI | `~/.local/share/vslsp/vslsp` |
| MCP server | `~/.local/share/vslsp/vslsp-mcp` |
| OmniSharp (C#) | `~/.local/share/vslsp/omnisharp/OmniSharp` |
| CSharpMapper (C#) | `~/.local/share/vslsp/csharp-mapper/CSharpMapper` |
| RustMapper (Rust) | `~/.local/share/vslsp/rust-mapper/RustMapper` |
| TSMapper (TypeScript) | `~/.local/share/vslsp/ts-mapper/TSMapper` |
| MCP registered in | `~/.claude.json` under `mcpServers.vslsp` |

---

## Key Source Files

| File | Owns |
|------|------|
| `mcp.ts` | All 10 MCP tool registrations, tool schemas, version string |
| `vslsp.ts` | CLI entry point, `install-mapper` command |
| `src/core/types.ts` | `DiagnosticsResult`, `DiagnosticEntry`, shared types |
| `src/core/language.ts` | `LanguageConfig`, `detectLanguage`, per-language daemon configs |
| `src/core/defaults.ts` | `DEFAULT_PORT`, `DEFAULT_VSLSP`, `DEFAULT_OMNISHARP`, binary paths |
| `src/diagnostics/collector.ts` | OmniSharp LSP session, C# diagnostics collection |
| `src/diagnostics/client.ts` | HTTP client for daemon (query/notify/stop/status) |
| `src/diagnostics/http.ts` | Daemon HTTP server |
| `src/diagnostics/rust.ts` | `collectRustDiagnostics()` via `cargo check --message-format=json` |
| `src/diagnostics/typescript.ts` | `collectTsDiagnostics()` via `tsc --noEmit` |
| `src/code-mapping/registry.ts` | Language registry — add entries here for new languages |
| `src/code-mapping/mapper.ts` | Routes `get_code_structure` by language, spawns binary |
| `tools/csharp-mapper/Program.cs` | Roslyn AST walker — C# structure analysis |
| `tools/rust-mapper/src/main.rs` | syn AST visitor — Rust structure analysis |
| `tools/ts-mapper/main.ts` | TS Compiler API walker — TypeScript structure analysis |
| `.github/workflows/release.yml` | CI: build-bun, build-csharpmapper, build-rust-mapper, build-ts-mapper, release jobs |
| `install.sh` | Installer + `configure_mcp()` → `~/.claude.json` |

---

## Build Commands (Dev)

```bash
# TypeScript (CLI + MCP server)
bun install
bun build vslsp.ts --compile --outfile vslsp
bun build mcp.ts --compile --outfile vslsp-mcp

# Type check only
bun run tsc --noEmit

# C# CSharpMapper
dotnet publish tools/csharp-mapper/CSharpMapper.csproj -c Release \
  -r osx-arm64 -p:PublishSingleFile=true --self-contained true -o /tmp/cm_out

# Rust RustMapper
cargo build --release --manifest-path tools/rust-mapper/Cargo.toml

# TypeScript TSMapper
cd tools/ts-mapper && bun install
bun build --compile tools/ts-mapper/main.ts --outfile TSMapper
```

## Verify Correctness (Dev)

```bash
# Tool count (must be 10)
grep -c "registerTool" mcp.ts

# TypeScript clean
bun run tsc --noEmit

# Verify daemon default port
grep DEFAULT_PORT src/core/defaults.ts
```
