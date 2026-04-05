# vslsp

AI agents working on C#, Rust, and TypeScript codebases are flying blind: they see three errors at a time from `dotnet build`, can't check whether a refactoring compiles without writing to disk, and have to read every source file to understand what a codebase contains.

vslsp fixes that. It's an MCP server that gives agents full compilation diagnostics and deep code structure awareness — for C#, Rust, and TypeScript — through a set of tools they can call directly.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash
```

Installs the CLI, MCP server, OmniSharp (C#), CodeMapper (C#), RustMapper (Rust), and TSMapper (TypeScript). Registers itself with Claude Code automatically.

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

The Rust and TypeScript gaps are all daemon-dependent. Rust uses `cargo`'s incremental build cache; TypeScript uses `tsc` directly — no long-running process needed, but no in-memory dry-run either.

## How it works

### C# workflow

```
get_code_structure    ← understand the codebase without reading files
       ↓
verify_changes        ← check proposed edits compile (no disk write)
       ↓
write files to disk
       ↓
notify_file_changed   ← sync the daemon
       ↓
get_diagnostics       ← confirm everything is clean
```

### Rust workflow

```
get_code_structure    ← understand crate structure
       ↓
edit files on disk
       ↓
get_rust_diagnostics  ← run cargo check, get structured results
```

### TypeScript workflow

```
get_code_structure    ← understand project structure (classes, interfaces, types)
       ↓
edit files on disk
       ↓
get_ts_diagnostics   ← run tsc --noEmit, get structured results
```

## MCP Tools

| Tool | Language | Purpose |
|------|----------|---------|
| `get_diagnostics` | C# | All compilation errors and warnings |
| `get_diagnostics_summary` | C# | Just the counts |
| `start_daemon` | C# | Start persistent analysis server |
| `stop_daemon` | C# | Stop it |
| `get_daemon_status` | C# | Check if ready |
| `notify_file_changed` | C# | Tell daemon a file changed |
| `verify_changes` | C# | Dry-run compile check before writing to disk |
| `get_rust_diagnostics` | Rust | All cargo check errors and warnings |
| `get_ts_diagnostics` | TypeScript | All tsc errors and warnings |
| `get_code_structure` | C# + Rust + TypeScript | Structured code map via AST analysis |

## Requirements

- .NET 6.0+ (for C# features)
- Rust and cargo (for Rust features)
- TypeScript / tsc (for TypeScript diagnostics)

## License

MIT
