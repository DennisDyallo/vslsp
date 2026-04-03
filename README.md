# vslsp - C# and Rust Agent Tooling Suite

A unified CLI and MCP server for AI agents working on C# and Rust codebases. Provides compilation diagnostics via OmniSharp LSP (C#) and `cargo check` (Rust), plus code structure mapping via Roslyn AST (C#) and syn AST (Rust).

## Why

`dotnet build` and `cargo check` only surface a few errors at a time. vslsp connects directly to language servers and build tools to surface ALL diagnostics at once — errors, warnings, info, hints — with file paths, line numbers, and error codes. It also maps code structure (classes, structs, methods, fields, enum variants) without reading every file.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash
```

### What Gets Installed

| Path | Description |
|------|-------------|
| `~/.local/share/vslsp/vslsp` | CLI binary |
| `~/.local/share/vslsp/vslsp-mcp` | MCP server binary |
| `~/.local/share/vslsp/omnisharp/` | OmniSharp LSP server (C#) |
| `~/.local/share/vslsp/code-mapper/` | CodeMapper — Roslyn AST analyzer (C#) |
| `~/.local/share/vslsp/rust-mapper/` | RustMapper — syn AST analyzer (Rust) |
| `~/.local/bin/vslsp` | CLI symlink |
| `~/.local/bin/vslsp-mcp` | MCP server symlink |

Add `~/.local/bin` to your PATH if not already present.

## MCP Server

The MCP server exposes 9 tools over stdio for AI agent consumption.

### C# Diagnostics

| Tool | Description |
|------|-------------|
| `get_diagnostics` | Get all C# compilation diagnostics (one-shot or daemon) |
| `get_diagnostics_summary` | Quick error/warning/info/hint counts |
| `start_daemon` | Start persistent OmniSharp daemon with file watching |
| `get_daemon_status` | Check daemon readiness and status |
| `stop_daemon` | Stop the running daemon |
| `notify_file_changed` | Tell daemon a file changed (disk or in-memory) |
| `verify_changes` | Dry-run: verify proposed changes compile without writing to disk |

### Rust Diagnostics

| Tool | Description |
|------|-------------|
| `get_rust_diagnostics` | Get all Rust compilation diagnostics via `cargo check` |

### Code Structure (C# and Rust)

| Tool | Description |
|------|-------------|
| `get_code_structure` | Map code structure via AST analysis (auto-detects C# or Rust) |

### Setup

The installer configures `~/.claude.json` automatically. To add manually:

```json
{
  "mcpServers": {
    "vslsp": {
      "command": "/Users/YOU/.local/bin/vslsp-mcp",
      "args": []
    }
  }
}
```

### C# Agent Workflow

```
get_code_structure ─── understand current code (Roslyn AST)
       │
verify_changes ─────── validate proposed edits compile (in-memory, no disk write)
       │
  if clean: write to disk
       │
notify_file_changed ── sync daemon to persisted state
       │
get_diagnostics ────── confirm final state
```

### Rust Agent Workflow

```
get_code_structure ─── understand crate structure (syn AST, language: "rust")
       │
  edit files on disk
       │
get_rust_diagnostics ── run cargo check, get structured diagnostics
```

### verify_changes (C# Dry-Run)

Agents can verify C# refactorings compile cleanly before writing to disk.

```
Input:  { changes: [{ file: "/path/File.cs", content: "..." }] }
Output: { summary: { errors: 0, ... }, clean: true, verified_files: [...], reverted: true }
```

Sends proposed content to OmniSharp via `didChange` (in-memory only), waits for re-analysis, collects diagnostics, then reverts to disk state. Supports multiple files for cross-file refactorings. Requires a running daemon (`start_daemon` first).

## Code Structure Output

Both C# and Rust produce the same JSON schema. Every member always emits all fields:

```json
{
  "type": "Method",
  "signature": "pub async fn classify(&self, payload: &[u8]) -> anyhow::Result<Output>",
  "lineNumber": 42,
  "isStatic": false,
  "visibility": "public",
  "docString": "Classify an intent payload.",
  "baseTypes": [],
  "attributes": [],
  "children": []
}
```

**Member types:** `Class`, `Struct`, `Enum`, `Variant`, `Field`, `Property`, `Method`, `Constructor`, `Record`, `Interface`, `Trait`, `Impl`, `Fn`, `Mod`, `Namespace`

**Visibility values:** `public`, `private`, `internal`, `protected`, `protected internal`, `crate`, `restricted(path)`

Struct fields and enum variants appear as `children` of their parent member. Signatures include modifiers verbatim (`pub async fn`, `public override async Task`).

## Diagnostics Output Format

All diagnostic tools return the same structured JSON schema:

```json
{
  "solution": "/path/to/project.sln",
  "timestamp": "2026-01-25T01:10:00.000Z",
  "summary": { "errors": 2, "warnings": 5, "info": 0, "hints": 0 },
  "clean": false,
  "files": [
    {
      "path": "/path/to/File.cs",
      "diagnostics": [
        {
          "severity": "error",
          "line": 10,
          "column": 5,
          "message": "; expected",
          "code": "CS1002",
          "source": "csharp"
        }
      ]
    }
  ]
}
```

Rust diagnostics use `"source": "rustc"` and error codes like `"E0596"`.

## CLI Usage

### C# Diagnostics

```bash
vslsp --solution ./MyProject.sln
vslsp --solution ./MyProject.sln --format pretty --timeout 60000
```

### Daemon Mode

```bash
vslsp serve --solution ./MyProject.sln --port 7850
vslsp query --port 7850
vslsp query --file src/MyFile.cs --port 7850
vslsp query --summary --port 7850
vslsp status --port 7850
vslsp notify --file src/MyFile.cs --port 7850
```

### Code Structure Mapping

```bash
# Auto-detect language from file extensions
vslsp map ./src --format json

# Explicit language
vslsp map ./src --language rust --format json
vslsp map ./src --language csharp --format text
```

## Requirements

- .NET 6.0+ runtime (for OmniSharp / C# features)
- Rust + cargo in PATH (for Rust diagnostics)
- Bun (for development only)

## Development

```bash
bun install
bun build vslsp.ts --compile --outfile vslsp
bun build mcp.ts --compile --outfile vslsp-mcp

# Build RustMapper
cargo build --release --manifest-path tools/rust-mapper/Cargo.toml
```

## License

MIT
