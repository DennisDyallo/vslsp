# vslsp

AI agents working on C#, Rust, and TypeScript codebases are flying blind: they see three errors at a time from `dotnet build`, can't check whether a refactoring compiles without writing to disk, and have to read every source file to understand what a codebase contains.

vslsp fixes that. It's an MCP server that gives agents full compilation diagnostics and deep code structure awareness — for C#, Rust, and TypeScript — through a set of tools they can call directly.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash
```

Installs the CLI, MCP server, OmniSharp (C#), CodeMapper (C#), RustMapper (Rust), and TSMapper (TypeScript). Registers itself with Claude Code automatically.

For other MCP clients (Cursor, Windsurf, etc.), add this to your MCP config manually:

```json
{
  "mcpServers": {
    "vslsp": {
      "command": "/Users/<you>/.local/share/vslsp/vslsp-mcp",
      "args": []
    }
  }
}
```

## What agents get

| Capability | C# | Rust | TypeScript |
|---|---|---|---|
| All compilation diagnostics at once | ✅ | ✅ | ✅ |
| Structured code map (types, methods, fields) | ✅ | ✅ | ✅ |
| Struct fields and enum variants in output | ✅ | ✅ | ✅ |
| Signatures with visibility, modifiers, generics | ✅ | ✅ | ✅ |
| Persistent daemon (fast repeated queries) | ✅ | ❌ | ❌ |
| Dry-run compile check before writing to disk | ✅ | ❌ | ❌ |
| File-watching (auto-update diagnostics on save) | ✅ | ❌ | ❌ |

The Rust and TypeScript gaps are daemon-dependent. Rust uses `cargo`'s incremental build cache; TypeScript uses `tsc` directly — fast, no daemon needed, but no in-memory dry-run either.

## Instructing your agent

Paste this into your system prompt or CLAUDE.md:

```
You have access to the vslsp MCP server. Use it as follows:

C# projects:
- Call get_code_structure(path) on the project directory to understand types and layout before editing.
- Before writing files, call start_daemon(solution) with the .sln path, poll get_daemon_status until ready is true, then use verify_changes to check that your edits compile. Only write to disk once verify_changes reports clean.
- After writing, call notify_file_changed(file) for each changed file, then get_diagnostics to confirm clean.

Rust projects:
- Call get_code_structure(path) on the crate directory to understand module and type layout.
- After editing files, call get_rust_diagnostics(manifest) with the path to Cargo.toml to check for errors.

TypeScript projects:
- Call get_code_structure(path) on the project directory to understand classes, interfaces, and types.
- After editing files, call get_ts_diagnostics(project) with the path to tsconfig.json (or the directory containing it) to check for errors.

Prefer get_code_structure over reading individual source files when you need to understand what exists.
```

## How it works

### C# workflow

```
get_code_structure(dir)       ← understand the codebase without reading files
         ↓
start_daemon(solution.sln)    ← start OmniSharp analysis server
         ↓
get_daemon_status()           ← poll until ready: true (takes 10–60s first time)
         ↓
verify_changes([{file, content}])  ← check proposed edits compile (no disk write)
         ↓
write files to disk
         ↓
notify_file_changed(file)     ← sync the daemon with saved content
         ↓
get_diagnostics(solution)     ← confirm everything is clean
```

> **Important:** `verify_changes` requires the daemon to be running and `ready: true`. Always poll `get_daemon_status` before calling it.

### Rust workflow

```
get_code_structure(dir)       ← understand crate structure
         ↓
edit files on disk
         ↓
get_rust_diagnostics(Cargo.toml)  ← run cargo check, get structured results
```

### TypeScript workflow

```
get_code_structure(dir)       ← understand project structure (classes, interfaces, types)
         ↓
edit files on disk
         ↓
get_ts_diagnostics(tsconfig.json)  ← run tsc --noEmit, get structured results
```

## MCP Tools

| Tool | Language | Purpose |
|------|----------|---------|
| `get_diagnostics` | C# | All compilation errors and warnings for a solution |
| `get_diagnostics_summary` | C# | Error/warning/info/hint counts only |
| `start_daemon` | C# | Start persistent OmniSharp analysis server |
| `stop_daemon` | C# | Stop it |
| `get_daemon_status` | C# | Check if ready (poll this after start_daemon) |
| `notify_file_changed` | C# | Tell daemon a file was saved to disk |
| `verify_changes` | C# | Dry-run compile check for proposed edits — daemon required |
| `get_rust_diagnostics` | Rust | All cargo check errors and warnings |
| `get_ts_diagnostics` | TypeScript | All tsc --noEmit errors and warnings |
| `get_code_structure` | All | Structured AST code map — types, methods, fields, signatures |

## Requirements

### C# features

- .NET 6.0 or later — verify with `dotnet --version`
- `DOTNET_ROOT` environment variable must be set if OmniSharp fails to start (see Troubleshooting)

### Rust features

- Rust toolchain with `cargo` in PATH — verify with `cargo --version`

### TypeScript features

- TypeScript compiler accessible as `tsc` or via `bunx`/`npx` — verify with `tsc --version`
- A `tsconfig.json` in your project (or pass its directory path to `get_ts_diagnostics`)

## Troubleshooting

**OmniSharp fails to start / "libhostfxr.dylib could not be found"**

OmniSharp is a framework-dependent .NET binary and needs to locate the .NET host. Set `DOTNET_ROOT` to your .NET installation:

```bash
# Find your .NET root
dirname $(dirname $(which dotnet))

# Add to your shell profile
export DOTNET_ROOT=/usr/local/share/dotnet   # adjust to your path
```

Restart your shell (and your MCP client) after setting it.

**Daemon never becomes ready / get_daemon_status returns ready: false indefinitely**

OmniSharp loads the full solution — on first run against a large solution this can take 60–90 seconds. Poll with a reasonable timeout. If it never becomes ready, check that the `.sln` path is correct and that `dotnet` is accessible.

**get_rust_diagnostics: "binary not found"**

The RustMapper binary is optional. Run the installer again or build it manually:

```bash
cargo build --release --manifest-path ~/.local/share/vslsp/source/tools/rust-mapper/Cargo.toml
```

**get_ts_diagnostics / get_code_structure (TypeScript): "binary not found"**

TSMapper is optional. Rebuild:

```bash
bun build --compile ~/.local/share/vslsp/source/tools/ts-mapper/main.ts --outfile ~/.local/share/vslsp/ts-mapper/TSMapper
```

**tsc not found**

Install TypeScript globally or ensure it's available in PATH:

```bash
npm install -g typescript   # or: bun add -g typescript
```

## License

MIT
