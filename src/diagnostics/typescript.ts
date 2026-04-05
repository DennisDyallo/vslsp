import { resolve, join } from "path";
import { existsSync } from "fs";
import { type DiagnosticsResult, type FileDiagnostics, type DiagnosticEntry, matchFilePath, calculateSummary } from "../core/types";

export interface TsDiagnosticsOptions {
  project: string;
  file?: string;
}

export async function collectTsDiagnostics(
  options: TsDiagnosticsOptions
): Promise<DiagnosticsResult> {
  let projectPath = resolve(options.project);
  if (!projectPath.endsWith("tsconfig.json")) {
    projectPath = join(projectPath, "tsconfig.json");
  }
  if (!existsSync(projectPath)) {
    throw new Error(`tsconfig.json not found at: ${projectPath}`);
  }

  const args = ["--noEmit", "--pretty", "false", "--project", projectPath];

  // Use bunx to resolve tsc from local or global typescript installation
  const proc = Bun.spawn(["bunx", "tsc", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text(); // drain stderr to prevent pipe deadlock
  await proc.exited;

  // tsc outputs diagnostics to stdout in format:
  // path(line,col): severity TSXXXX: message
  const output = stdout;
  const fileMap = new Map<string, DiagnosticEntry[]>();

  // Match: file(line,col): category TSXXXX: message
  const diagPattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|message)\s+(TS\d+):\s+(.+)$/;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(diagPattern);
    if (!match) continue;

    const filePath = match[1]!;
    const lineStr = match[2]!;
    const colStr = match[3]!;
    const category = match[4]!;
    const code = match[5]!;
    const message = match[6]!;
    const absPath = resolve(filePath);
    const severity = mapTsSeverity(category);

    const entry: DiagnosticEntry = {
      severity,
      line: parseInt(lineStr, 10),
      column: parseInt(colStr, 10),
      endLine: parseInt(lineStr, 10),
      endColumn: parseInt(colStr, 10),
      message,
      code,
      source: "tsc",
    };

    if (!fileMap.has(absPath)) fileMap.set(absPath, []);
    fileMap.get(absPath)!.push(entry);
  }

  let files: FileDiagnostics[] = Array.from(fileMap.entries())
    .map(([path, diagnostics]) => ({
      uri: `file://${path}`,
      path,
      diagnostics,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (options.file) {
    files = files.filter((f) => matchFilePath(f.path, options.file!));
  }

  const summary = calculateSummary(files);

  return {
    solution: projectPath,
    timestamp: new Date().toISOString(),
    summary,
    clean: summary.errors === 0,
    files,
  };
}

function mapTsSeverity(category: string): DiagnosticEntry["severity"] {
  switch (category) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "message":
      return "info";
    default:
      return "info";
  }
}
