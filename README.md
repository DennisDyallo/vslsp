# vslsp - C# Agent Tooling Suite

A unified CLI and MCP server for AI agents working on C# codebases. Provides comprehensive compilation diagnostics via OmniSharp LSP and code structure mapping via Roslyn AST analysis.

## Why

`dotnet build` only shows a few errors at a time. vslsp connects directly to OmniSharp LSP to surface ALL compilation diagnostics at once — errors, warnings, info, hints — with file paths, line numbers, and error codes. It also maps code structure (classes, methods, properties) without reading every file.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/dyallo/vslsp/main/install.sh | bash
```

### What Gets Installed

| Path | Description |
|------|-------------|
| `~/.local/share/vslsp/vslsp` | CLI binary |
| `~/.local/share/vslsp/vslsp-mcp` | MCP server binary |
| `~/.local/share/vslsp/omnisharp/` | OmniSharp LSP server |
| `~/.local/share/vslsp/code-mapper/` | CodeMapper (Roslyn AST) |
| `~/.local/bin/vslsp` | CLI symlink |
| `~/.local/bin/vslsp-mcp` | MCP server symlink |

Add `~/.local/bin` to your PATH if not already present.

## MCP Server

The MCP server exposes 7 tools over stdio for AI agent consumption:

| Tool | Description |
|------|-------------|
| `get_diagnostics` | Get all compilation diagnostics (one-shot or daemon) |
| `get_diagnostics_summary` | Quick error/warning/info/hint counts |
| `get_code_structure` | Map C# code structure via Roslyn AST |
| `start_daemon` | Start persistent daemon with file watching |
| `get_daemon_status` | Check daemon readiness and status |
| `notify_file_changed` | Tell daemon a file changed (disk or in-memory) |
| `verify_changes` | Dry-run: verify proposed changes compile without writing to disk |

### Setup

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "vslsp": {
      "command": "~/.local/bin/vslsp-mcp",
      "args": []
    }
  }
}
```

### Agent Workflow

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

### verify_changes (Dry-Run)

The standout feature: agents can verify refactorings compile cleanly before writing to disk.

```
Input:  { changes: [{ file: "/path/File.cs", content: "..." }] }
Output: { summary: { errors: 0, ... }, clean: true, verified_files: [...], reverted: true }
```

The tool sends proposed content to OmniSharp via `didChange` (in-memory only), waits for re-analysis, collects diagnostics, then reverts the daemon to disk state. Supports multiple files for cross-file refactorings.

## CLI Usage

### One-shot Diagnostics

```bash
vslsp --solution ./MyProject.sln
vslsp --solution ./MyProject.sln --format pretty --timeout 60000
```

### Daemon Mode

```bash
# Start persistent daemon (watches for file changes)
vslsp serve --solution ./MyProject.sln --port 7850

# Query diagnostics
vslsp query --port 7850
vslsp query --file src/MyFile.cs --port 7850
vslsp query --summary --port 7850

# Check status
vslsp status --port 7850

# Notify of file change
vslsp notify --file src/MyFile.cs --port 7850
```

### Code Structure Mapping

```bash
vslsp map ./src --format json
vslsp map ./src --format text
```

## Output Format

All tools return structured JSON:

```json
{
  "solution": "/path/to/solution.sln",
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

## Requirements

- .NET 6.0+ runtime (for OmniSharp)
- Bun (for development)

## Development

```bash
bun install
bun build vslsp.ts --compile --outfile vslsp
bun build mcp.ts --compile --outfile vslsp-mcp
```

## License

MIT
