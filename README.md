# vslsp

AI agents working on C#, Rust, and TypeScript codebases are flying blind: they see three errors at a time from `dotnet build`, can't check whether a refactoring compiles without writing to disk, and have to read every source file to understand what a codebase contains.

vslsp fixes that. It's an MCP server that gives agents full compilation diagnostics and deep code structure awareness — for C#, Rust, and TypeScript — through a set of tools they can call directly.

## Install

> **C# users:** vslsp uses OmniSharp for C# diagnostics, which requires .NET 6.0+. Verify first: `dotnet --version`. ([Install .NET](https://dotnet.microsoft.com/download))
> **Rust / TypeScript users:** No .NET required — you can skip C# entirely.

```bash
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash
```

Installs the CLI and MCP server. **OmniSharp (C#) and CSharpMapper are only downloaded if you select C#** — you won't pay for .NET if you don't need it. RustMapper and TSMapper are opt-in. You'll be prompted interactively, or pass `--mappers`:

```bash
# Install with specific mappers
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --mappers csharp,rust

# Install all mappers non-interactively (CI)
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --mappers all --yes

# TypeScript-only (no C# or Rust, non-interactive)
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --mappers typescript
```

Add mappers later without reinstalling:

```bash
vslsp install-mapper rust        # adds RustMapper
vslsp install-mapper typescript  # adds TSMapper
vslsp install-mapper csharp      # re-installs CSharpMapper
```

After install, two things happen automatically if Claude Code is installed:
- **MCP server** registered in `~/.claude.json` (all `mcp__vslsp__*` tools become available)
- **`/vslsp` skill** installed to `~/.claude/commands/vslsp.md` (type `/vslsp` in Claude Code to load the workflow guide)

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
- After editing files, call get_diagnostics(manifest) with the path to Cargo.toml to check for errors.

TypeScript projects:
- Call get_code_structure(path) on the project directory to understand classes, interfaces, and types.
- After editing files, call get_diagnostics(project) with the path to tsconfig.json (or the directory containing it) to check for errors.

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

**Step-by-step checklist:**

1. Call `start_daemon(solution)` with the absolute path to your `.sln` file
2. Poll `get_daemon_status()` in a loop until `ready: true` — expect 15–90s on first run
3. Call `verify_changes(changes)` to check proposed edits compile *without writing to disk*
4. If `result.clean === true`: write your files to disk
5. Call `notify_file_changed(file)` for each file you wrote
6. Call `get_diagnostics(solution)` to confirm final state

> The daemon persists across tool calls — start it once per session, not once per edit.

### Rust workflow

```
get_code_structure(dir)               ← understand crate structure
         ↓
edit files on disk
         ↓
get_diagnostics(Cargo.toml)           ← run cargo check, get structured results
```

> **First-time Rust setup:** Run `vslsp install-mapper rust` before first use. Without it, `get_code_structure` will report "binary not found".

### TypeScript workflow

```
get_code_structure(dir)                ← understand project structure
         ↓
edit files on disk
         ↓
get_diagnostics(tsconfig.json)         ← run tsc --noEmit, get structured results
```

Pass the path to `tsconfig.json` directly, or the directory containing it — vslsp will find it automatically. If your project has multiple tsconfig files (e.g. `tsconfig.build.json`), pass the specific one you want checked.

> **Why no daemon for TypeScript?** `tsc --noEmit` is stateless and fast enough to run directly — no persistent process needed. This means TypeScript has no dry-run mode (no write-free pre-check), but the workflow is simpler: edit, then check.

## MCP Tools

| Tool | Language | Purpose |
|------|----------|---------|
| `get_diagnostics` | C# / Rust / TypeScript | Compilation errors and warnings — pass `solution` (C#), `manifest` (Rust), or `project` (TypeScript) |
| `get_diagnostics_summary` | C# | Error/warning/info/hint counts only |
| `start_daemon` | C# | Start persistent OmniSharp analysis server |
| `stop_daemon` | C# | Stop it |
| `get_daemon_status` | C# | Check if ready (poll this after start_daemon) |
| `notify_file_changed` | C# | Tell daemon a file was saved to disk |
| `verify_changes` | C# | Dry-run compile check for proposed edits — daemon required |
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
- A `tsconfig.json` in your project (or pass its directory path to `get_diagnostics`)
- TSMapper installed: `vslsp install-mapper typescript`

## Verify your install

After installation, confirm everything is working:

```bash
# 1. CLI works
vslsp --help

# 2. MCP server registered (Claude Code)
cat ~/.claude.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('✓ MCP registered' if 'vslsp' in d.get('mcpServers',{}) else '✗ MCP not registered')"

# 3. /vslsp skill installed (Claude Code)
ls ~/.claude/commands/vslsp.md && echo "✓ Skill installed" || echo "✗ Skill not found (Claude Code may not be installed)"

# 4. Check which mappers are installed
ls ~/.local/share/vslsp/csharp-mapper/CSharpMapper 2>/dev/null && echo "✓ CSharpMapper" || echo "  CSharpMapper not installed"
ls ~/.local/share/vslsp/rust-mapper/RustMapper     2>/dev/null && echo "✓ RustMapper"   || echo "  RustMapper not installed (run: vslsp install-mapper rust)"
ls ~/.local/share/vslsp/ts-mapper/TSMapper         2>/dev/null && echo "✓ TSMapper"     || echo "  TSMapper not installed (run: vslsp install-mapper typescript)"
```

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

OmniSharp loads the full solution — on first run against a large solution this can take 60–90 seconds. Poll with a reasonable timeout. If it still doesn't become ready, work through these steps in order:

1. **Verify the `.sln` path is absolute and correct** — `ls /absolute/path/to/Your.sln` must return the file
2. **Confirm `dotnet` is in PATH** — `dotnet --version` must print a version ≥ 6.0
3. **Check if port 7850 is in use** — `lsof -i :7850`; if occupied, pass a different port: `start_daemon({ solution: "...", port: 7851 })`
4. **Check OmniSharp output** — run `vslsp serve --solution /abs/path/to/Your.sln` in a terminal; OmniSharp startup errors appear on stderr and will be visible directly
5. **Set `DOTNET_ROOT`** if dotnet is installed but OmniSharp can't find it: `export DOTNET_ROOT=$(dirname $(dirname $(which dotnet)))`, then restart your MCP client

**Custom daemon port / port 7850 already in use**

The daemon binds to port `7850` by default. All daemon tools accept an optional `port` parameter — pass the same value to every call in a session:

```bash
# Check what's using 7850
lsof -i :7850
```

Then use a free port across all daemon calls:

```
start_daemon({ solution: "...", port: 7851 })
get_daemon_status({ port: 7851 })
verify_changes({ changes: [...], port: 7851 })
notify_file_changed({ file: "...", port: 7851 })
get_diagnostics({ solution: "...", use_daemon: true, port: 7851 })
stop_daemon({ port: 7851 })
```

**get_code_structure / get_diagnostics: "binary not found"**

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
