# vslsp — Agent Reference

MCP server version: **1.1.1** | Tools: **10** | Languages: C#, Rust, TypeScript

---

## Agent Quick-Start

### Step 1 — understand what's in the codebase

Always start here. `get_code_structure` replaces reading individual source files.

```
get_code_structure({ path: "/path/to/project" })
```

Returns every class, struct, interface, method, property, field, enum variant with signatures, line numbers, visibility, base types, and doc comments. Language is auto-detected from file extensions; pass `language: "csharp" | "rust" | "typescript"` to override.

### Step 2 — check if your changes compile

Pick the workflow for the language you're editing:

| Language | Pre-write check | Post-write check |
|----------|----------------|-----------------|
| **C#** | `verify_changes` (daemon required) | `get_diagnostics` |
| **Rust** | — (no dry-run) | `get_rust_diagnostics` |
| **TypeScript** | — (no dry-run) | `get_ts_diagnostics` |

---

## C# Workflow (Full)

The C# daemon enables **dry-run compilation** — check whether edits compile *before writing to disk*.

```
1. start_daemon({ solution: "/abs/path/to/Project.sln" })
2. poll get_daemon_status() until ready === true  ← takes 10–90s on first run
3. verify_changes({ changes: [{ file: "/abs/path/File.cs", content: "..." }] })
   → returns DiagnosticsResult + verified_files; reverted: true means changes were not kept
4. If clean: write files to disk
5. notify_file_changed({ file: "/abs/path/File.cs" }) for each written file
6. get_diagnostics({ solution: "/abs/path/Project.sln" }) to confirm final state
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
2. Edit files on disk
3. get_rust_diagnostics({ manifest: "/path/to/Cargo.toml" })
```

`manifest` can be the path to `Cargo.toml` or the directory containing it.

Optional params: `package` (workspace member name), `file` (filter to one file), `all_targets` (include tests/benches).

---

## TypeScript Workflow

```
1. get_code_structure({ path: "/path/to/project" })   ← understand layout
2. Edit files on disk
3. get_ts_diagnostics({ project: "/path/to/tsconfig.json" })
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

### C# Diagnostics

```
get_diagnostics(solution, file?, timeout?, quiet_period?, use_daemon?, port?)
  → DiagnosticsResult
  solution: absolute path to .sln file
  file: filter results to a single file
  use_daemon: true = query running daemon instead of spawning OmniSharp fresh

get_diagnostics_summary(solution, use_daemon?, port?)
  → { errors, warnings, info, hints }
  Use this first to check if there are any errors at all before pulling full detail.

start_daemon(solution, port?)
  → { status, port, solution, ready }

get_daemon_status(port?)
  → { status, ready, updateCount, solution }
  Poll this after start_daemon. ready: true means verify_changes is safe to call.

stop_daemon(port?)
  → { status, port }

notify_file_changed(file, content?, port?)
  → { ok, file }
  content: string = in-memory update; omit to read from disk

verify_changes(changes[{file, content}], settle_ms?, timeout_ms?, port?)
  → DiagnosticsResult + { verified_files, reverted: true }
  REQUIRES: running daemon with ready: true
  Changes are applied in-memory and reverted — disk is never written.
```

### Rust Diagnostics

```
get_rust_diagnostics(manifest, package?, file?, all_targets?)
  → DiagnosticsResult
  manifest: path to Cargo.toml or directory containing one
  package: workspace member name (omit for default package)
  all_targets: true to include tests, benches, examples
```

### TypeScript Diagnostics

```
get_ts_diagnostics(project, file?)
  → DiagnosticsResult
  project: path to tsconfig.json or directory containing one
  file: filter to a single .ts file
```

### Code Structure

```
get_code_structure(path, format?, language?)
  → { output: string }  — JSON by default
  path: directory or single file
  format: "json" (default) | "text" | "yaml"
  language: "csharp" | "rust" | "typescript" — auto-detected from extensions if omitted
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
