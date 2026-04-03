# vslsp

AI agents working on C# and Rust codebases are flying blind: they see three errors at a time from `dotnet build`, can't check whether a refactoring compiles without writing to disk, and have to read every source file to understand what a codebase contains.

vslsp fixes that. It's an MCP server that gives agents full compilation diagnostics and deep code structure awareness — for both C# and Rust — through a set of tools they can call directly.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash
```

Installs the CLI, MCP server, OmniSharp (C#), CodeMapper (C#), and RustMapper (Rust). Registers itself with Claude Code automatically.

## What agents get

**For C# projects:**

- All compilation errors and warnings at once, not just the first few
- A structured map of every class, method, property, and field — without reading files
- Dry-run refactoring: check whether proposed code compiles before touching disk
- A persistent daemon that keeps diagnostics current as files change

**For Rust projects:**

- All `cargo check` errors and warnings, structured the same way as C# output
- A structured map of every struct, enum, trait, and function — including field names, variant shapes, and visibility

**For both:**

- Consistent JSON output so agents work the same way regardless of language
- Signatures that include visibility, async/unsafe/const modifiers, and generics

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
| `get_code_structure` | C# + Rust | Structured code map via AST analysis |

## Requirements

- .NET 6.0+ (for C# features)
- Rust and cargo (for Rust features)

## License

MIT
