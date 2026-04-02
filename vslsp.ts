#!/usr/bin/env bun
import { DiagnosticsCollector } from "./src/diagnostics/collector";
import { serve } from "./src/diagnostics/daemon";
import { query, status, notify } from "./src/diagnostics/client";
import { map } from "./src/code-mapping/mapper";
import { DEFAULT_PORT, DEFAULT_OMNISHARP, DEFAULT_CODE_MAPPER } from "./src/core/defaults";
import { existsSync } from "fs";
import { resolve } from "path";

const HELP = `
vslsp - C# LSP Diagnostics Tool

USAGE:
  # One-shot mode (backward compatible)
  vslsp --solution <path.sln> [options]

  # Daemon mode
  vslsp serve --solution <path.sln> [--port 7850]
  vslsp query [--file <path>] [--summary] [--port 7850]
  vslsp status [--port 7850]
  vslsp notify --file <path.cs> [--port 7850]

  # Code structure mapping
  vslsp map [path] [--format text|json|yaml] [--output dir]

COMMANDS:
  serve                 Start persistent daemon with HTTP API
  query                 Query diagnostics from running daemon
  status                Get daemon status
  notify                Notify daemon of file change
  map                   Map C# code structure (classes, methods, properties)

OPTIONS (one-shot mode):
  --solution <path>     Path to .sln file (required)
  --timeout <ms>        Maximum wait time (default: 60000)
  --quiet-period <ms>   Wait after last diagnostic (default: 5000)
  --format <type>       Output: compact | pretty (default: compact)
  --omnisharp <path>    OmniSharp binary path

OPTIONS (daemon mode):
  --port <number>       HTTP port (default: 7850)
  --file <path>         Filter by file (query) or file to notify
  --summary             Return only counts (query)

OPTIONS (map mode):
  --format <type>       Output: text | json | yaml (default: json)
  --output <dir>        Output directory (default: codebase_ast)
  --code-mapper <path>  CodeMapper binary path

EXAMPLES:
  # One-shot (existing behavior)
  vslsp --solution ./MyProject.sln

  # Start daemon
  vslsp serve --solution ./MyProject.sln --port 7850

  # Query daemon
  vslsp query                          # All diagnostics
  vslsp query --file src/Program.cs    # Filter by file
  vslsp query --summary                # Just counts

  # Notify file change
  vslsp notify --file src/Program.cs

  # Map code structure
  vslsp map .                          # Current dir, JSON format
  vslsp map ./src --format text        # Text tree format
  vslsp map . --format json --output ./docs
`;

type Command = "serve" | "query" | "status" | "notify" | "map" | "oneshot";

interface CLIArgs {
  command: Command;
  solution: string;
  timeout: number;
  quietPeriod: number;
  format: string;
  omnisharpPath: string;
  codeMapperPath: string;
  port: number;
  file: string;
  output: string;
  summary: boolean;
  help: boolean;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {
    command: "oneshot",
    solution: "",
    timeout: 60000,
    quietPeriod: 5000,
    format: "compact",
    omnisharpPath: DEFAULT_OMNISHARP,
    codeMapperPath: DEFAULT_CODE_MAPPER,
    port: DEFAULT_PORT,
    file: "",
    output: "",
    summary: false,
    help: false,
  };

  // Check for command as first arg
  const firstArg = args[0];
  if (args.length > 0 && firstArg && !firstArg.startsWith("-")) {
    if (firstArg === "serve" || firstArg === "query" || firstArg === "status" || firstArg === "notify" || firstArg === "map") {
      result.command = firstArg;
      args.shift();
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    switch (arg) {
      case "--solution":
      case "-s":
        result.solution = nextArg || "";
        i++;
        break;
      case "--timeout":
      case "-t":
        result.timeout = parseInt(nextArg || "60000", 10);
        i++;
        break;
      case "--quiet-period":
        result.quietPeriod = parseInt(nextArg || "5000", 10);
        i++;
        break;
      case "--format":
      case "-f":
        result.format = nextArg || "compact";
        i++;
        break;
      case "--omnisharp":
        result.omnisharpPath = nextArg || DEFAULT_OMNISHARP;
        i++;
        break;
      case "--port":
      case "-p":
        result.port = parseInt(nextArg || String(DEFAULT_PORT), 10);
        i++;
        break;
      case "--file":
        result.file = nextArg || "";
        i++;
        break;
      case "--output":
        result.output = nextArg || "";
        i++;
        break;
      case "--code-mapper":
        result.codeMapperPath = nextArg || DEFAULT_CODE_MAPPER;
        i++;
        break;
      case "--summary":
        result.summary = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
      default:
        // Positional arg: for 'map' command, treat as path
        if (arg && !arg.startsWith("-") && result.command === "map" && !result.file) {
          result.file = arg; // reuse file field as path for map
        }
        break;
    }
  }

  return result;
}

function error(message: string): never {
  console.error(`Error: ${message}`);
  console.error("Use --help for usage information.");
  process.exit(1);
}

async function runOneShot(args: CLIArgs): Promise<void> {
  if (!args.solution) {
    error("--solution is required");
  }

  const solutionPath = resolve(args.solution);
  if (!existsSync(solutionPath)) {
    error(`Solution file not found: ${solutionPath}`);
  }

  if (!solutionPath.endsWith(".sln")) {
    error("Solution path must be a .sln file");
  }

  const omnisharpPath = resolve(args.omnisharpPath);
  if (!existsSync(omnisharpPath) && !existsSync(omnisharpPath + ".exe")) {
    error(
      `OmniSharp binary not found at: ${omnisharpPath}\n` +
      "Run 'bun run scripts/download-omnisharp.ts' to download it."
    );
  }

  const collector = new DiagnosticsCollector({
    solutionPath,
    omnisharpPath,
    timeout: args.timeout,
    quietPeriod: args.quietPeriod,
  });

  try {
    const result = await collector.collect();
    const output = args.format === "pretty"
      ? JSON.stringify(result, null, 2)
      : JSON.stringify(result);
    console.log(output);
    process.exit(result.clean ? 0 : 1);
  } catch (err) {
    error(`Failed to collect diagnostics: ${err}`);
  }
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  switch (args.command) {
    case "serve":
      if (!args.solution) {
        error("--solution is required for serve command");
      }
      await serve({
        solution: args.solution,
        port: args.port,
        omnisharpPath: args.omnisharpPath,
      });
      break;

    case "query": {
      const result = await query({
        port: args.port,
        file: args.file || undefined,
        summary: args.summary,
      });
      const output = args.format === "pretty"
        ? JSON.stringify(result.data, null, 2)
        : JSON.stringify(result.data);
      console.log(output);
      if (!result.clean) process.exit(1);
      break;
    }

    case "status": {
      const statusResult = await status(args.port);
      console.log(JSON.stringify(statusResult, null, 2));
      break;
    }

    case "notify": {
      if (!args.file) {
        error("--file is required for notify command");
      }
      const notifyResult = await notify({
        port: args.port,
        file: args.file,
      });
      console.log(`Notified: ${notifyResult.action} for ${notifyResult.path}`);
      break;
    }

    case "map": {
      const mapResult = await map({
        path: args.file || ".",
        format: (args.format === "compact" ? "json" : args.format) as "text" | "json" | "yaml",
        output: args.output || undefined,
        codeMapperPath: args.codeMapperPath,
      });
      if (mapResult.output) console.log(mapResult.output);
      process.exit(mapResult.exitCode);
    }

    case "oneshot":
    default:
      await runOneShot(args);
      break;
  }
}

main().catch((err) => {
  if ((err as any).code === "DAEMON_NOT_RUNNING") {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
});
