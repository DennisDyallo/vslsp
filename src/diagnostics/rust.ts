import { resolve, join } from "path";
import { existsSync } from "fs";
import { type DiagnosticsResult, type FileDiagnostics, type DiagnosticEntry, type DiagnosticSummary, matchFilePath } from "../core/types";

export interface RustDiagnosticsOptions {
  manifest: string;
  package?: string;
  file?: string;
  allTargets?: boolean;
}

export async function collectRustDiagnostics(
  options: RustDiagnosticsOptions
): Promise<DiagnosticsResult> {
  // Resolve manifest to an absolute Cargo.toml path
  let manifestPath = resolve(options.manifest);
  if (!manifestPath.endsWith("Cargo.toml")) {
    manifestPath = join(manifestPath, "Cargo.toml");
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`Cargo.toml not found at: ${manifestPath}`);
  }

  const args = ["check", "--message-format=json", "--manifest-path", manifestPath];
  if (options.package) args.push("--package", options.package);
  if (options.allTargets) args.push("--all-targets");

  const proc = Bun.spawn(["cargo", ...args], {
    stdout: "pipe",
    stderr: "pipe", // suppress cargo progress output
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  // Parse newline-delimited JSON from cargo
  const fileMap = new Map<string, DiagnosticEntry[]>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Only process compiler diagnostic messages
    if (msg.reason !== "compiler-message") continue;

    const cargoMsg = msg.message;
    if (!cargoMsg) continue;

    const level: string = cargoMsg.level ?? "error";
    const severity = mapLevel(level);
    const code: string | undefined = cargoMsg.code?.code ?? undefined;
    const spans: any[] = cargoMsg.spans ?? [];

    // Use the primary span; fall back to first span if none is primary
    const primary = spans.find((s: any) => s.is_primary) ?? spans[0];
    if (!primary) continue;

    // cargo reports paths relative to workspace root — resolve to absolute
    const absPath = resolve(primary.file_name);

    const entry: DiagnosticEntry = {
      severity,
      line: primary.line_start,
      column: primary.column_start,
      endLine: primary.line_end,
      endColumn: primary.column_end,
      message: cargoMsg.message,
      code,
      source: "rustc",
    };

    if (!fileMap.has(absPath)) fileMap.set(absPath, []);
    fileMap.get(absPath)!.push(entry);
  }

  // Build file list, sorted for deterministic output
  let files: FileDiagnostics[] = Array.from(fileMap.entries())
    .map(([path, diagnostics]) => ({
      uri: `file://${path}`,
      path,
      diagnostics,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  // Apply optional file filter (match by suffix or full path)
  if (options.file) {
    files = files.filter((f) => matchFilePath(f.path, options.file!));
  }

  const summary: DiagnosticSummary = { errors: 0, warnings: 0, info: 0, hints: 0 };
  for (const f of files) {
    for (const d of f.diagnostics) {
      if (d.severity === "error") summary.errors++;
      else if (d.severity === "warning") summary.warnings++;
      else if (d.severity === "hint") summary.hints++;
      else summary.info++;
    }
  }

  return {
    solution: manifestPath,
    timestamp: new Date().toISOString(),
    summary,
    clean: summary.errors === 0,
    files,
  };
}

function mapLevel(level: string): DiagnosticEntry["severity"] {
  switch (level) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "note":
    case "help":
      return "info";
    default:
      return "info";
  }
}
