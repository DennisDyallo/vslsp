# vslsp

AI agents working on C#, Rust, and TypeScript codebases are flying blind: they see three errors at a time from `dotnet build`, can't check whether a refactoring compiles without writing to disk, and have to read every source file to understand what a codebase contains.

vslsp fixes that. It's an MCP server that gives agents full compilation diagnostics and deep code structure awareness — for C#, Rust, and TypeScript — through a set of tools they can call directly.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash
```

Installs the CLI, MCP server, OmniSharp (C#), and CSharpMapper (C#) by default. RustMapper and TSMapper are opt-in — you'll be prompted interactively, or pass `--mappers` to skip the prompt:

```bash
# Install with specific mappers
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --mappers csharp,rust

# Install all mappers non-interactively (CI)
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --mappers all --yes
```

Add mappers later without reinstalling:

```bash
vslsp install-mapper rust        # adds RustMapper
vslsp install-mapper typescript  # adds TSMapper
vslsp install-mapper csharp      # re-installs CSharpMapper
```

Registers itself with Claude Code automatically. For other MCP clients (Cursor, Windsurf, etc.), add this to your MCP config manually:

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
All paths passed to vslsp tools must be absolute.
```

## How it works

### C# workflow

```
get_code_structure(dir)            ← understand the codebase without reading files
         ↓
start_daemon(solution.sln)         ← start OmniSharp analysis server
         ↓
get_daemon_status()                ← poll until ready: true (10–90s first run)
         ↓
verify_changes([{file, content}])  ← check proposed edits compile (no disk write)
         ↓
write files to disk
         ↓
notify_file_changed(file)          ← sync the daemon with saved content
         ↓
get_diagnostics(solution)          ← confirm everything is clean
```

> **Important:** `verify_changes` requires the daemon to be running and `ready: true`. Always poll `get_daemon_status` before calling it. The daemon persists across calls — start it once per session.

### Rust workflow

```
get_code_structure(dir)               ← understand crate structure
         ↓
edit files on disk
         ↓
get_rust_diagnostics(Cargo.toml)      ← run cargo check, get structured results
```

### TypeScript workflow

```
get_code_structure(dir)                ← understand project structure
         ↓
edit files on disk
         ↓
get_ts_diagnostics(tsconfig.json)      ← run tsc --noEmit, get structured results
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
- RustMapper installed: `vslsp install-mapper rust`

### TypeScript features

- TypeScript compiler accessible as `tsc` or via `bunx`/`npx` — verify with `tsc --version`
- A `tsconfig.json` in your project (or pass its directory path to `get_ts_diagnostics`)
- TSMapper installed: `vslsp install-mapper typescript`

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

**get_code_structure / get_rust_diagnostics: "binary not found"**

The mapper for that language isn't installed. Run:

```bash
vslsp install-mapper rust        # for Rust
vslsp install-mapper typescript  # for TypeScript
vslsp install-mapper csharp      # for C#
```

This downloads the correct binary for your platform and version in seconds.

**tsc not found**

Install TypeScript globally or ensure it's available in PATH:

```bash
npm install -g typescript   # or: bun add -g typescript
```

## License

MIT
