#!/usr/bin/env bun
import { DiagnosticsCollector } from "./src/diagnostics";
import { serve } from "./src/commands/serve";
import { query, status } from "./src/commands/query";
import { notify } from "./src/commands/notify";
import { existsSync } from "fs";
import { resolve, join } from "path";

const DEFAULT_PORT = 7850;
const DEFAULT_OMNISHARP = join(process.env.HOME || "~", ".local", "share", "vslsp", "omnisharp", "OmniSharp");

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

COMMANDS:
  serve                 Start persistent daemon with HTTP API
  query                 Query diagnostics from running daemon
  status                Get daemon status
  notify                Notify daemon of file change

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
`;

type Command = "serve" | "query" | "status" | "notify" | "oneshot";

interface CLIArgs {
  command: Command;
  solution: string;
  timeout: number;
  quietPeriod: number;
  format: "compact" | "pretty";
  omnisharpPath: string;
  port: number;
  file: string;
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
    port: DEFAULT_PORT,
    file: "",
    summary: false,
    help: false,
  };

  // Check for command as first arg
  const firstArg = args[0];
  if (args.length > 0 && firstArg && !firstArg.startsWith("-")) {
    if (firstArg === "serve" || firstArg === "query" || firstArg === "status" || firstArg === "notify") {
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
        result.format = (nextArg || "compact") as "compact" | "pretty";
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
      case "--summary":
        result.summary = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
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

    case "query":
      await query({
        port: args.port,
        file: args.file || undefined,
        summary: args.summary,
        format: args.format,
      });
      break;

    case "status":
      await status(args.port);
      break;

    case "notify":
      if (!args.file) {
        error("--file is required for notify command");
      }
      await notify({
        port: args.port,
        file: args.file,
      });
      break;

    case "oneshot":
    default:
      await runOneShot(args);
      break;
  }
}

main();
