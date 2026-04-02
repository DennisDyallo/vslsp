#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readFileSync } from "fs";
import { DiagnosticsCollector } from "./src/diagnostics/collector";
import { query, status, notify, stop } from "./src/diagnostics/client";
import { map } from "./src/code-mapping/mapper";
import { DEFAULT_PORT, DEFAULT_OMNISHARP, DEFAULT_VSLSP } from "./src/core/defaults";

function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

const server = new McpServer({
  name: "vslsp",
  version: "1.0.0",
});

// --- Diagnostics Tools ---

server.registerTool(
  "get_diagnostics",
  {
    title: "Get C# Diagnostics",
    description:
      "Get C# compilation diagnostics (errors, warnings, info, hints) for a .NET solution. " +
      "Use this to find ALL compilation errors at once instead of running dotnet build which only shows a few at a time. " +
      "Returns structured diagnostics with file paths, line numbers, and error codes. " +
      "For persistent sessions, use start_daemon first then set use_daemon=true. Call notify_file_changed after editing files.",
    inputSchema: {
      solution: z.string().describe("Absolute path to .sln file"),
      file: z.string().optional().describe("Filter diagnostics to a specific file path"),
      timeout: z.number().optional().default(60000).describe("Max wait time in ms for OmniSharp analysis"),
      quiet_period: z.number().optional().default(5000).describe("Wait time after last diagnostic before considering analysis complete"),
      use_daemon: z.boolean().optional().default(false).describe("Query running daemon instead of one-shot analysis"),
      port: z.number().optional().default(DEFAULT_PORT).describe("Daemon port (only used with use_daemon)"),
    },
    annotations: {
      title: "Get C# Diagnostics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ solution, file, timeout, quiet_period, use_daemon, port }) => {
    try {
      if (use_daemon) {
        const result = await query({ port, file, summary: false });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
        };
      }

      const collector = new DiagnosticsCollector({
        solutionPath: solution,
        omnisharpPath: DEFAULT_OMNISHARP,
        timeout,
        quietPeriod: quiet_period,
      });

      const result = await collector.collect();

      if (file) {
        const normalizedFile = file.replace(/\\/g, "/");
        result.files = result.files.filter((f) => {
          const fPath = f.path.replace(/\\/g, "/");
          return fPath === normalizedFile || fPath.endsWith(normalizedFile);
        });
        result.summary = { errors: 0, warnings: 0, info: 0, hints: 0 };
        for (const f of result.files) {
          for (const d of f.diagnostics) {
            result.summary[d.severity === "error" ? "errors" : d.severity === "warning" ? "warnings" : d.severity === "hint" ? "hints" : "info"]++;
          }
        }
        result.clean = result.summary.errors === 0;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "get_diagnostics_summary",
  {
    title: "Get C# Diagnostics Summary",
    description:
      "Get a quick summary of C# compilation diagnostic counts (errors, warnings, info, hints). " +
      "Faster than get_diagnostics when you only need counts.",
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
      "Supports C# (via Roslyn) and Rust (when RustMapper is installed). " +
      "Language is auto-detected from file extensions; override with the language param. " +
      "Use this to understand a codebase without reading every file. " +
      "Pair with verify_changes to validate proposed edits compile before writing to disk.",
    inputSchema: {
      path: z.string().describe("Path to directory or file to analyze"),
      format: z.enum(["text", "json", "yaml"]).optional().default("json").describe("Output format"),
      language: z.enum(["csharp", "rust"]).optional().describe("Language to analyze. Auto-detected from file extensions if omitted."),
    },
    annotations: {
      title: "Get Code Structure",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path, format, language }) => {
    try {
      const result = await map({ path, format, language });
      return {
        content: [{ type: "text" as const, text: result.output }],
      };
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
      "Start a persistent vslsp diagnostics daemon for a .NET solution. " +
      "The daemon watches for file changes and keeps diagnostics up-to-date. " +
      "Use get_diagnostics with use_daemon=true to query it after starting. " +
      "After starting, poll get_daemon_status until ready=true.",
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
      // Check if daemon is already running
      try {
        const existing = await status(port);
        return ok({ status: "already_running", port, solution: existing.solution, ready: existing.ready });
      } catch {
        // Not running, proceed to start
      }

      // Spawn daemon as detached subprocess using absolute path (avoids PATH issues in MCP context)
      Bun.spawn([DEFAULT_VSLSP, "serve", "--solution", solution, "--port", String(port)], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
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
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "get_daemon_status",
  {
    title: "Get Daemon Status",
    description: "Check if a vslsp diagnostics daemon is running and get its status.",
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
      file: z.string().describe("Absolute path to the .cs file"),
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
    try {
      // 1. Apply each change via in-memory notify (didChange)
      const paths: string[] = [];
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
          paths.some((p) => f.path === p || f.path.endsWith(p.split("/").pop()!))
        );
        data.summary = { errors: 0, warnings: 0, info: 0, hints: 0 };
        for (const f of data.files) {
          for (const d of f.diagnostics) {
            data.summary[d.severity === "error" ? "errors" : d.severity === "warning" ? "warnings" : d.severity === "hint" ? "hints" : "info"]++;
          }
        }
        data.clean = data.summary.errors === 0;
      }

      return ok({ ...data, verified_files: paths, reverted: true });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
