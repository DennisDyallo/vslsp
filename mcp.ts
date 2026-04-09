#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readFileSync } from "fs";
import { DiagnosticsCollector } from "./src/diagnostics/collector";
import { query, status, notify, stop } from "./src/diagnostics/client";
import { map } from "./src/code-mapping/mapper";
import { matchFilePath, calculateSummary } from "./src/core/types";
import { collectRustDiagnostics } from "./src/diagnostics/rust";
import { collectTsDiagnostics } from "./src/diagnostics/typescript";
import { DEFAULT_PORT, DEFAULT_OMNISHARP, DEFAULT_VSLSP } from "./src/core/defaults";
import { setLogLevel, getLogLevel, log } from "./src/core/logger";
import pkg from "./package.json";

// Parse --log-level flag
const logLevelArg = process.argv.indexOf("--log-level");
const VALID_LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
if (logLevelArg !== -1 && process.argv[logLevelArg + 1]) {
  const lvl = process.argv[logLevelArg + 1];
  if (VALID_LOG_LEVELS.includes(lvl as any)) {
    setLogLevel(lvl as "error" | "warn" | "info" | "debug");
  }
}

function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

// ── Output filter helpers ──────────────────────────────────────────────────

/** Kinds that count as "types" in the summary (excludes containers like Namespace/Mod/Impl). */
const TYPE_MEMBER_KINDS = new Set([
  "Class", "Struct", "Interface", "Enum", "Record", "Trait", "Type",
]);
/** Kinds kept by depth: "types" — includes containers so their type children are preserved. */
const TYPE_DEPTH_KINDS = new Set([
  ...TYPE_MEMBER_KINDS, "Namespace", "Mod", "Impl",
]);
const METHOD_MEMBER_KINDS = new Set(["Method", "Constructor", "Fn"]);

/** Recursively count types and methods in a members array. */
function countMembers(members: any[]): { types: number; methods: number } {
  let types = 0, methods = 0;
  for (const m of members) {
    if (TYPE_MEMBER_KINDS.has(m.type)) types++;
    if (METHOD_MEMBER_KINDS.has(m.type)) methods++;
    if (m.children?.length) {
      const c = countMembers(m.children);
      types += c.types;
      methods += c.methods;
    }
  }
  return { types, methods };
}

/** Strip member children according to depth level. */
function applyDepth(members: any[], depth: string): any[] {
  if (depth === "full") return members;
  if (depth === "types") {
    // Type names only — no methods, no children
    return members
      .filter(m => TYPE_DEPTH_KINDS.has(m.type))
      .map(m => ({ ...m, children: applyDepth(m.children ?? [], "types") }));
  }
  // depth === "signatures": all members, but grandchildren stripped
  return members.map(m => ({
    ...m,
    children: (m.children ?? []).map((c: any) => ({ ...c, children: [] })),
  }));
}

// Match a file path against a glob pattern.
// Direct match handles relative paths (e.g. pattern "src/[star][star]" vs "src/core/types.ts").
// Fallback with a **/ prefix is only applied for filename-only patterns (no "/" in pattern)
// so that "*.ts" matches absolute paths.  Path-prefixed patterns like "src/**" are NOT
// broadened -- otherwise they would incorrectly match "tests/fixtures/src/foo.ts".
function matchGlob(filePath: string, pattern: string): boolean {
  const g1 = new Bun.Glob(pattern);
  if (g1.match(filePath)) return true;
  // Only apply **/ fallback for filename-only patterns (no path separators)
  if (!pattern.includes("/")) {
    const g2 = new Bun.Glob("**/" + pattern);
    return g2.match(filePath);
  }
  return false;
}

/**
 * AX context window budget: maximum response size for get_code_structure.
 * Responses exceeding this are automatically truncated (files removed from end)
 * with a warning field explaining what happened and how to scope further.
 */
const AX_BUDGET_BYTES = 200_000;

/** Apply post-processing filters to a get_code_structure JSON result. */
function filterCodeStructure(
  parsed: any,
  opts: { file_filter?: string; max_files?: number; depth?: string; autoDetected: boolean }
): any {
  let files: any[] = parsed.files ?? [];

  // Glob filter
  const preFilterCount = files.length;
  if (opts.file_filter) {
    files = files.filter(f => matchGlob(f.filePath ?? "", opts.file_filter!));
  }
  // Depth filter — also prune files with no remaining members (avoids wasting max_files slots)
  if (opts.depth && opts.depth !== "full") {
    files = files
      .map(f => ({ ...f, members: applyDepth(f.members ?? [], opts.depth!) }))
      .filter(f => f.members.length > 0);
  }
  // Max files cap (explicit)
  if (opts.max_files !== undefined) {
    files = files.slice(0, opts.max_files);
  }

  // AX byte-budget truncation: if no explicit max_files and response exceeds budget,
  // progressively remove files from the end until under budget.
  let axTruncated = false;
  let preCapFileCount = files.length;
  if (opts.max_files === undefined) {
    const probe = buildResult(files, opts.autoDetected);
    const probeSize = JSON.stringify(probe, null, 2).length;
    if (probeSize > AX_BUDGET_BYTES && files.length > 1) {
      // Binary search for the largest file count that fits within budget
      // Use pretty-printed JSON (null, 2) to match actual MCP response format
      let lo = 1, hi = files.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = buildResult(files.slice(0, mid), opts.autoDetected);
        if (JSON.stringify(candidate, null, 2).length <= AX_BUDGET_BYTES) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      files = files.slice(0, lo);
      axTruncated = true;
    }
  }

  const result = buildResult(files, opts.autoDetected);

  // Warn when an explicit file_filter matched 0 files (distinct from auto-detect empty)
  if (opts.file_filter && files.length === 0 && preFilterCount > 0) {
    const msg =
      `file_filter "${opts.file_filter}" matched 0 of ${preFilterCount} files. ` +
      `Check the glob pattern — use 'src/**' for a subtree or '**/*.ts' for all TypeScript files.`;
    result.warning = result.warning ? result.warning + " " + msg : msg;
  }

  // Build AX warning — merge with any existing warning (e.g. auto-detection) instead of overwriting
  if (axTruncated) {
    const axMsg =
      `Response truncated from ${preCapFileCount} to ${files.length} files to fit context window budget (${Math.round(AX_BUDGET_BYTES / 1000)}KB). ` +
      `Use file_filter (e.g. "src/**") or max_files to scope results.`;
    result.warning = result.warning ? result.warning + " " + axMsg : axMsg;
  }

  // Single-file edge case: if even 1 file exceeds budget, warn but return it
  if (!axTruncated && opts.max_files === undefined && files.length > 0) {
    const size = JSON.stringify(result, null, 2).length;
    if (size > AX_BUDGET_BYTES) {
      const sizeKB = Math.round(size / 1000);
      const msg =
        `Response (${sizeKB}KB) exceeds context window budget (${Math.round(AX_BUDGET_BYTES / 1000)}KB). ` +
        `Try depth: "types" or depth: "signatures" to reduce output, or use file_filter to narrow scope.`;
      result.warning = result.warning ? result.warning + " " + msg : msg;
    }
  }

  return result;
}

/** Count Namespace/Mod members recursively (Rust uses "Mod" for modules). */
function countNamespaces(members: any[]): number {
  let count = 0;
  for (const m of members) {
    if (m.type === "Namespace" || m.type === "Mod") count++;
    if (m.children?.length) count += countNamespaces(m.children);
  }
  return count;
}

/** Build the final result object with recomputed summary and optional warnings. */
function buildResult(
  files: any[],
  autoDetected: boolean,
): any {
  const totalMembers = files.flatMap((f: any) => f.members ?? []);
  const { types, methods } = countMembers(totalMembers);
  const namespaces = countNamespaces(totalMembers);
  const summary = { files: files.length, namespaces, types, methods };

  const result: any = { summary, files };

  // Auto-detection warning: no explicit language and zero files returned
  if (autoDetected && files.length === 0) {
    result.warning =
      "Language was auto-detected but 0 files were found. " +
      "If this is a TypeScript, Rust, or C# project, pass language: \"typescript\", \"rust\", or \"csharp\" explicitly.";
  }

  return result;
}

/** Severity ordering: lower = more severe. */
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** Filter a DiagnosticsResult by minimum severity and total limit. */
function filterDiagnostics(result: any, minSeverity?: string, limit?: number): any {
  if (!minSeverity && limit === undefined) return result;

  const maxLevel = minSeverity !== undefined ? (SEVERITY_ORDER[minSeverity] ?? 3) : 3;
  let remaining = limit ?? Infinity;
  const filteredFiles = [];

  for (const file of result.files ?? []) {
    if (remaining <= 0) break;
    // Side-effectful filter: decrements remaining to enforce cross-file limit
    const diags = (file.diagnostics ?? []).filter((d: any) => {
      if (remaining <= 0) return false;
      if ((SEVERITY_ORDER[d.severity] ?? 3) > maxLevel) return false;
      remaining--;
      return true;
    });
    if (diags.length > 0) filteredFiles.push({ ...file, diagnostics: diags });
  }

  // Recompute summary
  const summary = { errors: 0, warnings: 0, info: 0, hints: 0 };
  for (const file of filteredFiles) {
    for (const d of file.diagnostics) {
      if (d.severity === "error") summary.errors++;
      else if (d.severity === "warning") summary.warnings++;
      else if (d.severity === "info") summary.info++;
      else if (d.severity === "hint") summary.hints++;
    }
  }

  return { ...result, summary, files: filteredFiles, clean: summary.errors === 0 };
}

// Concurrency guard for verify_changes — prevents parallel calls from corrupting daemon state
let verifyLockChain: Promise<void> = Promise.resolve();
function acquireVerifyLock(): Promise<() => void> {
  let release: () => void;
  const prev = verifyLockChain;
  verifyLockChain = new Promise((r) => { release = r; });
  return prev.then(() => release!);
}

const server = new McpServer({
  name: "vslsp",
  version: pkg.version,
});

// --- Diagnostics Tools ---

server.registerTool(
  "get_diagnostics",
  {
    title: "Get Diagnostics",
    description:
      "Get compilation diagnostics for C#, Rust, or TypeScript — one tool, three overloads. " +
      "Provide exactly one of: solution (C#), manifest (Rust), or project (TypeScript). " +
      "Returns the same DiagnosticsResult schema for all languages: file paths, line numbers, error codes, severity. " +
      "C#: runs OmniSharp against a .sln file. " +
      "Rust: runs cargo check against a Cargo.toml. " +
      "TypeScript: runs tsc --noEmit against a tsconfig.json. " +
      "Use severity and limit to scope results — unfiltered responses on large codebases can return " +
      "hundreds of diagnostics. Start with severity:'error', limit:20 for a focused first pass.",
    inputSchema: z.object({
      // === Provide exactly one (selects language): ===
      solution: z.string().optional().describe(
        "C#: absolute path to .sln file. Provide this OR manifest OR project."
      ),
      manifest: z.string().optional().describe(
        "Rust: path to Cargo.toml or directory containing one. Provide this OR solution OR project."
      ),
      project: z.string().optional().describe(
        "TypeScript: path to tsconfig.json or directory containing one. Provide this OR solution OR manifest."
      ),
      // === Shared (all languages): ===
      file: z.string().optional().describe("Filter diagnostics to a single source file path."),
      severity: z.enum(["error", "warning", "info", "hint"]).optional().describe(
        "Minimum severity to include. 'error' = errors only; 'warning' = errors + warnings; etc. Default: all. " +
        "Without this, large codebases may return hundreds of diagnostics — use 'error' to stay within the context window budget."
      ),
      limit: z.number().optional().describe(
        "Maximum total diagnostics to return across all files. Use 20–50 for a quick overview. " +
        "Without a limit, all matching diagnostics are returned; combine with severity:'error' for a focused response under 10KB."
      ),
      // === C#-only (ignored for Rust/TypeScript): ===
      timeout: z.number().optional().default(60000).describe("C# only. Max wait in ms for OmniSharp analysis."),
      quiet_period: z.number().optional().default(5000).describe("C# only. Wait after last diagnostic before analysis is complete."),
      use_daemon: z.boolean().optional().default(false).describe("C# only. Query running daemon instead of one-shot analysis."),
      port: z.number().optional().default(DEFAULT_PORT).describe("C# only. Daemon port (only used with use_daemon)."),
      // === Rust-only (ignored for C#/TypeScript): ===
      package: z.string().optional().describe("Rust only. Specific package name in a workspace."),
      all_targets: z.boolean().optional().default(false).describe("Rust only. Include tests, examples, and benches."),
    }).refine(
      (args) => [args.solution, args.manifest, args.project].filter(Boolean).length === 1,
      { message: "Provide exactly one of: solution (C#), manifest (Rust), or project (TypeScript)." }
    ),
    annotations: {
      title: "Get Diagnostics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ solution, manifest, project, file, severity, limit, timeout, quiet_period, use_daemon, port, package: rustPackage, all_targets }) => {
    try {
      // --- Rust ---
      if (manifest) {
        const raw = await collectRustDiagnostics({ manifest, package: rustPackage, file, allTargets: all_targets });
        const result = filterDiagnostics(raw, severity, limit);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      // --- TypeScript ---
      if (project) {
        const raw = await collectTsDiagnostics({ project, file });
        const result = filterDiagnostics(raw, severity, limit);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      // --- C# ---
      log("info", "get_diagnostics", { solution, use_daemon, file });
      if (use_daemon) {
        const raw = await query({ port, file, summary: false });
        const result = filterDiagnostics(raw.data, severity, limit);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      const collector = new DiagnosticsCollector({
        solutionPath: solution!,
        omnisharpPath: DEFAULT_OMNISHARP,
        timeout,
        quietPeriod: quiet_period,
      });

      let result = await collector.collect();

      if (file) {
        result.files = result.files.filter((f) => matchFilePath(f.path, file));
        result.summary = calculateSummary(result.files);
        result.clean = result.summary.errors === 0;
      }

      const filtered = filterDiagnostics(result, severity, limit);
      return { content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }] };
    } catch (e) {
      log("error", "tool error", { tool: "get_diagnostics", message: e instanceof Error ? e.message : String(e) });
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "get_diagnostics_summary",
  {
    title: "Get C# Diagnostics Summary",
    description:
      "Get a quick count of C# compilation diagnostics (errors, warnings, info, hints). " +
      "Call this first to check whether there are any errors before deciding to pull full detail with get_diagnostics. " +
      "If summary.errors === 0 you can skip get_diagnostics entirely.",
    inputSchema: {
      solution: z.string().describe("Absolute path to .sln file"),
      use_daemon: z.boolean().optional().default(false).describe("Query running daemon instead of one-shot analysis"),
      port: z.number().optional().default(DEFAULT_PORT).describe("Daemon port (only used with use_daemon)"),
    },
    annotations: {
      title: "Get C# Diagnostics Summary",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ solution, use_daemon, port }) => {
    try {
      if (use_daemon) {
        const result = await query({ port, summary: true });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
        };
      }

      const collector = new DiagnosticsCollector({
        solutionPath: solution,
        omnisharpPath: DEFAULT_OMNISHARP,
        timeout: 60000,
        quietPeriod: 5000,
      });

      const result = await collector.collect();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.summary, null, 2) }],
      };
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// --- Code Structure Tools ---

server.registerTool(
  "get_code_structure",
  {
    title: "Get Code Structure",
    description:
      "Map code structure using AST analysis. Returns classes, interfaces, methods, " +
      "properties, records, enums with their signatures, line numbers, base types, and doc comments. " +
      "Supports C# (via Roslyn), Rust (via syn), and TypeScript (via TS Compiler API). " +
      "Language is auto-detected from file extensions; override with the language param. " +
      "Use this to understand a codebase without reading every file. " +
      "Pair with verify_changes to validate proposed edits compile before writing to disk. " +
      "AX WARNING: calling on a directory without filters returns 3–5MB of JSON on real codebases, " +
      "consuming your entire context window. Always pass depth:'signatures' and scope with " +
      "file_filter or max_files. The 200KB context window budget is enforced automatically — " +
      "oversized responses are truncated with a warning field.",
    inputSchema: {
      path: z.string().describe("Absolute path to directory or file to analyze"),
      format: z.enum(["text", "json", "yaml"]).optional().default("json").describe("Output format. Ignored when any filter param is set (always returns JSON)."),
      language: z.enum(["csharp", "rust", "typescript"]).optional().describe(
        "Language to analyze. Auto-detected from file extensions if omitted. " +
        "Auto-detection may silently return 0 files — pass explicitly for reliable results."
      ),
      depth: z.enum(["types", "signatures", "full"]).optional().default("full").describe(
        "Output detail level. " +
        "'types': type names only, no methods — fits within 30KB AX budget. " +
        "'signatures': types + method signatures, no nested children — fits within 200KB context window budget for most codebases. " +
        "'full': complete recursive output (default) — use only for single files; on directories may exceed 1MB. " +
        "Prefer 'signatures' for directory-level calls."
      ),
      file_filter: z.string().optional().describe(
        "Glob pattern to filter files (e.g. 'src/Core/**', '**/*.service.ts'). Applied before depth and max_files. " +
        "Without this on large codebases, response may exceed the 200KB context window budget even with depth:'signatures'."
      ),
      max_files: z.number().optional().describe(
        "Maximum number of files to return. Applied after file_filter. Use 10–20 for a focused overview. " +
        "If omitted and response exceeds 200KB, files are auto-truncated with a warning field."
      ),
    },
    annotations: {
      title: "Get Code Structure",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path, format, language, depth, file_filter, max_files }) => {
    try {
      const needsFilter = file_filter !== undefined || max_files !== undefined || (depth && depth !== "full");
      // Always use JSON when filtering or when default format is JSON — AX budget
      // enforcement requires parsing the output, so all JSON responses go through
      // filterCodeStructure regardless of whether explicit filters are set.
      const effectiveFormat = needsFilter ? "json" : (format ?? "json");
      const result = await map({ path, format: effectiveFormat, language });

      if (effectiveFormat === "json") {
        let parsed: any;
        try {
          parsed = JSON.parse(result.output);
        } catch {
          const detail = result.stderr ? ` Mapper stderr: ${result.stderr}` : "";
          return err(`Failed to parse mapper JSON output.${detail}`);
        }
        const filtered = filterCodeStructure(parsed, {
          file_filter,
          max_files,
          depth: depth ?? "full",
          autoDetected: !language,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }] };
      }

      return { content: [{ type: "text" as const, text: result.output }] };
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// --- Daemon Management Tools ---

server.registerTool(
  "start_daemon",
  {
    title: "Start Diagnostics Daemon",
    description:
      "Start a persistent OmniSharp daemon for a .NET solution. " +
      "Required before calling verify_changes — the daemon enables dry-run compilation without writing to disk. " +
      "Also speeds up repeated get_diagnostics calls (use use_daemon=true). " +
      "After calling this, poll get_daemon_status until ready=true before using verify_changes. " +
      "First startup takes 15–90s depending on solution size. Daemon persists across tool calls.",
    inputSchema: {
      solution: z.string().describe("Absolute path to .sln file"),
      port: z.number().optional().default(DEFAULT_PORT).describe("HTTP port for daemon"),
    },
    annotations: {
      title: "Start Diagnostics Daemon",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ solution, port }) => {
    try {
      log("info", "start_daemon", { solution, port });
      // Check if daemon is already running
      try {
        const existing = await status(port);
        return ok({ status: "already_running", port, solution: existing.solution, ready: existing.ready });
      } catch {
        // Not running, proceed to start
      }

      // Spawn daemon as detached subprocess using absolute path (avoids PATH issues in MCP context)
      // Forward --log-level so the daemon writes structured logs at the same level as the MCP server
      const spawnArgs = [DEFAULT_VSLSP, "serve", "--solution", solution, "--port", String(port)];
      const lvl = getLogLevel();
      if (lvl !== "error") spawnArgs.push("--log-level", lvl);
      // Explicitly pass process.env — Bun compiled binaries do not always propagate
      // the full environment to grandchild processes (e.g. DOTNET_ROOT for OmniSharp).
      Bun.spawn(spawnArgs, {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: process.env,
      });

      // Wait a moment for it to start, then check status
      await new Promise((resolve) => setTimeout(resolve, 2000));

      try {
        const result = await status(port);
        return ok({ status: "started", port, solution: result.solution, ready: result.ready });
      } catch {
        return ok({ status: "starting", port, solution, ready: false, message: "Initial analysis in progress. Poll get_daemon_status until ready=true." });
      }
    } catch (e) {
      log("error", "tool error", { tool: "start_daemon", message: e instanceof Error ? e.message : String(e) });
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "get_daemon_status",
  {
    title: "Get Daemon Status",
    description:
      "Check daemon status. Poll this after start_daemon until ready=true before calling verify_changes. " +
      "ready=true means OmniSharp has fully loaded the solution and diagnostics are live. " +
      "updateCount increments each time OmniSharp processes a file change — use it to detect when analysis has settled.",
    inputSchema: {
      port: z.number().optional().default(DEFAULT_PORT).describe("Daemon port to check"),
    },
    annotations: {
      title: "Get Daemon Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ port }) => {
    try {
      const result = await status(port);
      return ok({ status: "running", ...result });
    } catch (e) {
      if ((e as any).code === "DAEMON_NOT_RUNNING") {
        return ok({ status: "not_running", port });
      }
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "stop_daemon",
  {
    title: "Stop Diagnostics Daemon",
    description:
      "Stop the running vslsp diagnostics daemon. " +
      "Use when done with a session or to restart with a different solution.",
    inputSchema: {
      port: z.number().optional().default(DEFAULT_PORT).describe("Daemon port"),
    },
    annotations: {
      title: "Stop Diagnostics Daemon",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ port }) => {
    try {
      await stop(port);
      return ok({ status: "stopped", port });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// --- File Change Notification ---

server.registerTool(
  "notify_file_changed",
  {
    title: "Notify File Changed",
    description:
      "Tell the running daemon a .cs file changed so it re-analyzes. " +
      "If content is provided, updates in-memory only (no disk read). " +
      "If omitted, daemon reads the file from disk.",
    inputSchema: {
      file: z.string().describe("Absolute path to the changed source file"),
      content: z.string().optional().describe("New file content for in-memory update. Omit to read from disk."),
      port: z.number().optional().default(DEFAULT_PORT).describe("Daemon port"),
    },
    annotations: {
      title: "Notify File Changed",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ file, content, port }) => {
    try {
      const result = await notify({ port, file, content });
      return ok({ ...result });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// --- Dry-Run Verification ---

server.registerTool(
  "verify_changes",
  {
    title: "Verify Changes (Dry Run)",
    description:
      "Dry-run: send proposed code to the daemon WITHOUT writing to disk. " +
      "Returns compilation diagnostics for the proposed state, then reverts. " +
      "Supports multiple files for cross-file refactorings. " +
      "REQUIRES a running daemon (call start_daemon first).",
    inputSchema: {
      changes: z.array(z.object({
        file: z.string().describe("Absolute path to .cs file"),
        content: z.string().describe("Proposed file content"),
      })).describe("Files to verify"),
      settle_ms: z.number().optional().default(2000).describe("Wait after last OmniSharp update before collecting results"),
      timeout_ms: z.number().optional().default(30000).describe("Max wait for analysis"),
      port: z.number().optional().default(DEFAULT_PORT).describe("Daemon port"),
    },
    annotations: {
      title: "Verify Changes",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ changes, settle_ms, timeout_ms, port }) => {
    const release = await acquireVerifyLock();
    const paths: string[] = [];
    try {
      log("info", "verify_changes", { files: changes.map(c => c.file).join(", ") });
      // 1. Apply each change via in-memory notify (didChange)
      for (const c of changes) {
        await notify({ port, file: c.file, content: c.content });
        paths.push(c.file);
      }

      // 2. Wait for OmniSharp to settle (poll updateCount via status())
      const initial = await status(port);
      const startCount = initial.updateCount;
      const deadline = Date.now() + timeout_ms;
      let lastCount = startCount;
      let lastChangeAt = Date.now();

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        const s = await status(port);
        if (s.updateCount !== lastCount) {
          lastCount = s.updateCount;
          lastChangeAt = Date.now();
        }
        if (lastCount > startCount && Date.now() - lastChangeAt >= settle_ms) break;
      }

      // 3. Query diagnostics
      const result = await query({ port, summary: false });

      // 4. Revert: send disk content back via didChange
      for (const filePath of paths) {
        try {
          const diskContent = readFileSync(filePath, "utf-8");
          await notify({ port, file: filePath, content: diskContent });
        } catch {
          // File may not exist on disk (new file) — OmniSharp will reconcile on next didSave
        }
      }

      // 5. Filter result to only changed files
      const data = result.data;
      if (data.files) {
        data.files = data.files.filter((f: any) =>
          paths.some((p) => matchFilePath(f.path, p))
        );
        data.summary = calculateSummary(data.files);
        data.clean = data.summary.errors === 0;
      }

      return ok({ ...data, verified_files: paths, reverted: true });
    } catch (e) {
      // Best-effort revert: restore disk content for any files applied before the failure
      for (const filePath of paths) {
        try {
          const diskContent = readFileSync(filePath, "utf-8");
          await notify({ port, file: filePath, content: diskContent });
        } catch {
          // Ignore — daemon may not be running; OmniSharp will reconcile on next didSave
        }
      }
      log("error", "tool error", { tool: "verify_changes", message: e instanceof Error ? e.message : String(e) });
      return err(e instanceof Error ? e.message : String(e));
    } finally {
      release();
    }
  }
);


// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
