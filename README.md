# vslsp - C# LSP Diagnostics Tool

A Bun-compatible CLI tool that connects to OmniSharp LSP server to fetch C# diagnostics (errors, warnings, compile status) for .NET solutions. Designed for AI agent consumption via the Skill framework.

## Installation

```bash
bun install
```

This will automatically download the OmniSharp binary for your platform.

## Usage

```bash
bun run vslsp.ts --solution /path/to/MySolution.sln
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--solution, -s` | Path to .sln file (required) | - |
| `--timeout, -t` | Maximum wait time in ms | 30000 |
| `--quiet-period` | Time after last diagnostic to wait | 3000 |
| `--format, -f` | Output format: `compact` or `pretty` | compact |
| `--omnisharp` | Path to OmniSharp binary | ./omnisharp/OmniSharp |
| `--help, -h` | Show help | - |

### Examples

```bash
# Basic usage
bun run vslsp.ts --solution ./MyProject.sln

# Pretty-printed output with longer timeout
bun run vslsp.ts --solution ./MyProject.sln --format pretty --timeout 60000

# Using custom OmniSharp path
bun run vslsp.ts --solution ./MyProject.sln --omnisharp /usr/local/bin/OmniSharp
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

## AI Agent Integration

This tool is designed for AI agents (like GitHub Copilot or Claude) to check C# code health. Example skill invocation:

```bash
# Check for errors before making changes
bun run vslsp.ts --solution ./MyProject.sln

# Parse JSON output to determine if build is clean
# Use summary.errors to count compilation errors
```

## Manual OmniSharp Setup

If automatic download fails, manually download from [OmniSharp releases](https://github.com/OmniSharp/omnisharp-roslyn/releases):

1. Download the appropriate archive for your platform (e.g., `omnisharp-linux-x64-net6.0.tar.gz`)
2. Extract to `./omnisharp/`
3. Ensure the binary is executable: `chmod +x ./omnisharp/OmniSharp`

## Requirements

- [Bun](https://bun.sh/) runtime
- .NET 6.0+ runtime (for OmniSharp)
- Valid .NET solution file

## License

MIT
