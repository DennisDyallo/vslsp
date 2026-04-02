#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DiagnosticsCollector } from "./src/diagnostics/collector";
import { query, status, notify } from "./src/diagnostics/client";
import { map } from "./src/code-mapping/mapper";
import { DEFAULT_PORT, DEFAULT_OMNISHARP, DEFAULT_CODE_MAPPER } from "./src/core/defaults";

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
      "Returns structured diagnostics with file paths, line numbers, and error codes.",
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
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
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
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// --- Code Structure Tools ---

server.registerTool(
  "get_code_structure",
  {
    title: "Get C# Code Structure",
    description:
      "Map C# code structure using Roslyn AST analysis. Returns classes, interfaces, methods, " +
      "properties, records, enums with their signatures, line numbers, base types, and doc comments. " +
      "Use this to understand a C# codebase without reading every file.",
    inputSchema: {
      path: z.string().describe("Path to directory or file to analyze"),
      format: z.enum(["text", "json", "yaml"]).optional().default("json").describe("Output format"),
    },
    annotations: {
      title: "Get C# Code Structure",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path, format }) => {
    try {
      const result = await map({ path, format, codeMapperPath: DEFAULT_CODE_MAPPER });
      return {
        content: [{ type: "text" as const, text: result.output }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
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
      "Use get_diagnostics with use_daemon=true to query it after starting.",
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
        return {
          content: [{ type: "text" as const, text: `Daemon already running on port ${port} for ${existing.solution}` }],
        };
      } catch {
        // Not running, proceed to start
      }

      // Spawn daemon as detached subprocess
      const proc = Bun.spawn(["vslsp", "serve", "--solution", solution, "--port", String(port)], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });

      // Wait a moment for it to start, then check status
      await new Promise((resolve) => setTimeout(resolve, 2000));

      try {
        const result = await status(port);
        return {
          content: [{ type: "text" as const, text: `Daemon started on port ${port} for ${result.solution}. Ready: ${result.ready}` }],
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `Daemon process spawned on port ${port}. It may take 10-60s to finish initial analysis.` }],
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
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
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if ((err as any).code === "DAEMON_NOT_RUNNING") {
        return {
          content: [{ type: "text" as const, text: `No daemon running on port ${port}` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
