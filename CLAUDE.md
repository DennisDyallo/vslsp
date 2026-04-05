# vslsp — Agent Reference

MCP server version: **1.1.0** | Tools: **10** | Languages: C#, Rust, TypeScript

## Installed Binaries

| Binary | Path |
|--------|------|
| CLI | `~/.local/share/vslsp/vslsp` |
| MCP server | `~/.local/share/vslsp/vslsp-mcp` |
| OmniSharp (C#) | `~/.local/share/vslsp/omnisharp/OmniSharp` |
| CodeMapper (C#) | `~/.local/share/vslsp/code-mapper/CodeMapper` |
| RustMapper (Rust) | `~/.local/share/vslsp/rust-mapper/RustMapper` |
| TSMapper (TypeScript) | `~/.local/share/vslsp/ts-mapper/TSMapper` |
| MCP registered in | `~/.claude.json` under `mcpServers.vslsp` |

## Build Commands

```bash
# TypeScript (CLI + MCP server)
bun install
bun build vslsp.ts --compile --outfile vslsp
bun build mcp.ts --compile --outfile vslsp-mcp

# Type check only
bun run tsc --noEmit

# C# CodeMapper
dotnet publish tools/code-mapper/CodeMapper.csproj -c Release \
  -r osx-arm64 -p:PublishSingleFile=true --self-contained true -o /tmp/cm_out

# Rust RustMapper
cargo build --release --manifest-path tools/rust-mapper/Cargo.toml

# TypeScript TSMapper
cd tools/ts-mapper && bun install
bun build --compile tools/ts-mapper/main.ts --outfile TSMapper
```

## Key Files

| File | Owns |
|------|------|
| `mcp.ts` | All 10 MCP tool registrations, tool schemas, version string |
| `vslsp.ts` | CLI entry point |
| `src/core/types.ts` | `DiagnosticsResult`, `DiagnosticEntry`, shared types |
| `src/core/defaults.ts` | `DEFAULT_PORT`, `DEFAULT_VSLSP`, `DEFAULT_OMNISHARP`, binary paths |
| `src/diagnostics/collector.ts` | OmniSharp LSP session, C# diagnostics collection |
| `src/diagnostics/client.ts` | HTTP client for daemon (query/notify/stop/status) |
| `src/diagnostics/http.ts` | Daemon HTTP server |
| `src/diagnostics/rust.ts` | `collectRustDiagnostics()` via `cargo check --message-format=json` |
| `src/diagnostics/typescript.ts` | `collectTsDiagnostics()` via `tsc --noEmit` |
| `src/code-mapping/registry.ts` | Language registry — add entries here for new languages |
| `src/code-mapping/mapper.ts` | Routes `get_code_structure` by language, spawns binary |
| `tools/code-mapper/Program.cs` | Roslyn AST walker — C# structure analysis |
| `tools/rust-mapper/src/main.rs` | syn AST visitor — Rust structure analysis |
| `tools/ts-mapper/main.ts` | TS Compiler API walker — TypeScript structure analysis |
| `.github/workflows/release.yml` | CI: build-bun, build-codemapper, build-rust-mapper, build-ts-mapper, release jobs |
| `install.sh` | Installer + `configure_mcp()` → `~/.claude.json` |

## MCP Tool Reference

### C# Diagnostics

```
get_diagnostics(solution, file?, timeout?, quiet_period?, use_daemon?, port?)
  → DiagnosticsResult

get_diagnostics_summary(solution, use_daemon?, port?)
  → { errors, warnings, info, hints }

start_daemon(solution, port?)
  → { status, port, solution, ready }

get_daemon_status(port?)
  → { status, ready, updateCount, solution }

stop_daemon(port?)
  → { status, port }

notify_file_changed(file, content?, port?)
  → { ok, file }

verify_changes(changes[{file, content}], settle_ms?, timeout_ms?, port?)
  → DiagnosticsResult + { verified_files, reverted: true }
  REQUIRES: running daemon
```

### Rust Diagnostics

```
get_rust_diagnostics(manifest, package?, file?, all_targets?)
  → DiagnosticsResult
  manifest: path to Cargo.toml or directory containing one
```

### TypeScript Diagnostics

```
get_ts_diagnostics(project, file?)
  → DiagnosticsResult
  project: path to tsconfig.json or directory containing one
```

### Code Structure

```
get_code_structure(path, format?, language?)
  → { output: string }  (JSON/text/yaml)
  language: "csharp" | "rust" | "typescript" — auto-detected from file extensions if omitted
  path: directory or single file
```

## DiagnosticsResult Schema

```typescript
{
  solution: string,          // path to .sln or Cargo.toml
  timestamp: string,         // ISO 8601
  summary: { errors: number, warnings: number, info: number, hints: number },
  clean: boolean,
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
      code: string,          // "CS1002", "E0596", etc.
      source: string,        // "csharp", "rustc", or "tsc"
    }]
  }]
}
```

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

## Verify Correctness

```bash
# Tool count (must be 10)
grep -c "registerTool" mcp.ts

# TypeScript clean
bun run tsc --noEmit

# Test RustMapper
~/.local/share/vslsp/rust-mapper/RustMapper /path/to/rust/project --stdout 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary'])"

# Test get_rust_diagnostics via MCP
# mcp__vslsp__get_rust_diagnostics({ manifest: "/path/to/Cargo.toml" })

# Verify daemon default port
grep DEFAULT_PORT src/core/defaults.ts
```

## Constraints

- `verify_changes` requires a running daemon — call `start_daemon` first, poll `get_daemon_status` until `ready: true`
- `notify_file_changed` with `content` does in-memory update (no disk read); without `content` reads from disk
- RustMapper binary is optional at install time — `get_code_structure` with `language: "rust"` fails with "binary not found" if absent
- TSMapper binary is optional at install time — `get_code_structure` with `language: "typescript"` fails with "binary not found" if absent
- Daemon default port: `7850` (see `src/core/defaults.ts`)
- Daemon binds to `127.0.0.1` only (localhost) — not accessible from LAN
- OmniSharp requires .NET 6.0+; RustMapper requires cargo in PATH; tsc required for TS diagnostics
