# vslsp - C# LSP Diagnostics Tool

A CLI tool that connects to OmniSharp LSP server to fetch C# diagnostics (errors, warnings, compile status) for .NET solutions. Designed for AI agent consumption.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/dyallo/vslsp/main/install.sh | bash
```

This single command:
1. Detects your platform (Linux/macOS, x64/arm64)
2. Downloads the latest `vslsp` binary
3. Downloads OmniSharp v1.39.11
4. Installs to `~/.local/share/vslsp/`
5. Creates a symlink at `~/.local/bin/vslsp`

### What Gets Installed

| Path | Description |
|------|-------------|
| `~/.local/share/vslsp/vslsp` | Main binary |
| `~/.local/share/vslsp/omnisharp/` | OmniSharp LSP server |
| `~/.local/bin/vslsp` | Symlink for PATH access |

### PATH Setup

If `~/.local/bin` is not in your PATH, add this to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Usage

```bash
vslsp --solution /path/to/MySolution.sln
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--solution, -s` | Path to .sln file (required) | - |
| `--timeout, -t` | Maximum wait time in ms | 30000 |
| `--quiet-period` | Time after last diagnostic to wait | 3000 |
| `--format, -f` | Output format: `compact` or `pretty` | compact |
| `--omnisharp` | Path to OmniSharp binary | ~/.local/share/vslsp/omnisharp/OmniSharp |
| `--help, -h` | Show help | - |

### Examples

```bash
# Basic usage
vslsp --solution ./MyProject.sln

# Pretty-printed output with longer timeout
vslsp --solution ./MyProject.sln --format pretty --timeout 60000

# Using custom OmniSharp path
vslsp --solution ./MyProject.sln --omnisharp /usr/local/bin/OmniSharp
```

## Output Format

JSON output to stdout:

```json
{
  "solution": "/path/to/solution.sln",
  "timestamp": "2026-01-25T01:10:00.000Z",
  "summary": {
    "errors": 2,
    "warnings": 5,
    "info": 0,
    "hints": 0
  },
  "clean": false,
  "files": [
    {
      "uri": "file:///path/to/File.cs",
      "path": "/path/to/File.cs",
      "diagnostics": [
        {
          "severity": "error",
          "line": 10,
          "column": 5,
          "endLine": 10,
          "endColumn": 15,
          "message": "; expected",
          "code": "CS1002",
          "source": "csharp"
        }
      ]
    }
  ]
}
```

### Exit Codes

- `0` - No errors (clean build)
- `1` - Errors found or execution failure

## Requirements

- .NET 6.0+ runtime (for OmniSharp)
- `curl` or `wget` (for installation)
- Linux (x64/arm64) or macOS (x64/arm64)

## Manual Installation

If the install script fails, you can manually install:

1. Download the binary for your platform from [releases](https://github.com/dyallo/vslsp/releases)
2. Download OmniSharp from [OmniSharp releases](https://github.com/OmniSharp/omnisharp-roslyn/releases) (e.g., `omnisharp-linux-x64-net6.0.tar.gz`)
3. Extract both to your preferred location
4. Run with `--omnisharp` flag pointing to the OmniSharp binary

## Uninstall

```bash
rm -rf ~/.local/share/vslsp ~/.local/bin/vslsp
```

## License

MIT
