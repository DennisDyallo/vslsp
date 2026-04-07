---
description: "vslsp workflow guide — how to use the vslsp MCP tools for C#, Rust, and TypeScript diagnostics and code structure analysis. Invoke with /vslsp when starting work on a .NET, Rust, or TypeScript codebase."
---

# vslsp Skill

You have access to the `vslsp` MCP server with 10 tools for diagnostics and code structure analysis. This skill tells you how to use them correctly together.

---

## Decision: which tool to call first

**Always start with `get_code_structure`** on the project directory before editing anything.  
It returns every class, method, field, and type with signatures and line numbers — replacing the need to read individual source files.

```
mcp__vslsp__get_code_structure({ path: "/absolute/path/to/project" })
```

Then pick the workflow for the language you're editing:

| Language | Before writing | After writing |
|----------|---------------|---------------|
| C# | `verify_changes` (daemon required) | `get_diagnostics` |
| Rust | — | `get_rust_diagnostics` |
| TypeScript | — | `get_ts_diagnostics` |

---

## C# Workflow

### Pre-edit: understand the codebase

```
mcp__vslsp__get_code_structure({ path: "/abs/path/to/project" })
```

### Pre-write: dry-run check (recommended)

The daemon lets you verify edits compile *before* writing to disk. Start it once per session.

```
1. mcp__vslsp__start_daemon({ solution: "/abs/path/to/Project.sln" })

2. Poll until ready:
   mcp__vslsp__get_daemon_status()
   → repeat until result.ready === true (takes 15–90s first run)

3. Verify proposed edits in-memory:
   mcp__vslsp__verify_changes({
     changes: [
       { file: "/abs/path/to/File.cs", content: "// full proposed content" },
       { file: "/abs/path/to/Other.cs", content: "// another file" }
     ],
     settle_ms: 2000,
     timeout_ms: 30000
   })
   → returns DiagnosticsResult + { verified_files, reverted: true }
   → result.clean === true means no errors — safe to write

4. Write files to disk only if result.clean === true

5. Notify daemon of saved files:
   mcp__vslsp__notify_file_changed({ file: "/abs/path/to/File.cs" })

6. Confirm:
   mcp__vslsp__get_diagnostics({ solution: "/abs/path/Project.sln", use_daemon: true })
```

> `verify_changes` never writes to disk. It applies changes in-memory, waits for OmniSharp to settle, reads diagnostics, then reverts. Your disk state is always preserved.

### Quick check without daemon

If you don't need dry-run and just want current diagnostics:

```
mcp__vslsp__get_diagnostics_summary({ solution: "/abs/path/Project.sln" })
→ { errors: 0, warnings: 2, info: 0, hints: 0 }

# Only pull full detail if there are errors:
mcp__vslsp__get_diagnostics({ solution: "/abs/path/Project.sln" })
```

---

## Rust Workflow

```
1. mcp__vslsp__get_code_structure({ path: "/abs/path/to/crate" })

2. Edit files on disk

3. mcp__vslsp__get_rust_diagnostics({ manifest: "/abs/path/to/Cargo.toml" })
   → result.clean === true means no errors
```

For workspace crates: pass `package: "crate-name"` to check a specific member.  
For tests/benches: pass `all_targets: true`.

---

## TypeScript Workflow

```
1. mcp__vslsp__get_code_structure({ path: "/abs/path/to/project" })

2. Edit files on disk

3. mcp__vslsp__get_ts_diagnostics({ project: "/abs/path/to/tsconfig.json" })
   → result.clean === true means no errors
```

Pass `file:` to filter to a single changed file.

---

## If a Mapper Binary Is Missing

When `get_code_structure` returns "binary not found", the mapper for that language isn't installed. Run the install command from a terminal:

```bash
vslsp install-mapper rust        # Rust / syn AST
vslsp install-mapper typescript  # TypeScript / TS Compiler API
vslsp install-mapper csharp      # C# / Roslyn
```

This downloads only that binary for the current platform — nothing else is touched.

---

## Key Rules

- All paths must be **absolute** — relative paths are not supported
- `verify_changes` requires the daemon to be running and `ready: true` — always poll `get_daemon_status` first
- The daemon persists across tool calls — start it once per session, not once per verify call
- `notify_file_changed` with `content` = in-memory update (no disk read); without `content` = reads from disk
- `get_diagnostics_summary` is faster than `get_diagnostics` — use it first to check if errors exist before pulling detail

---

## DiagnosticsResult schema (all three languages)

```json
{
  "solution": "/path/to/project",
  "timestamp": "2026-04-07T10:30:00Z",
  "summary": { "errors": 2, "warnings": 5, "info": 0, "hints": 1 },
  "clean": false,
  "files": [{
    "path": "/abs/path/to/file.cs",
    "diagnostics": [{
      "severity": "error",
      "line": 15,
      "column": 10,
      "message": "CS1002: ; expected",
      "code": "CS1002",
      "source": "csharp"
    }]
  }]
}
```

`result.clean === true` is the single boolean to check. Don't count errors manually.
