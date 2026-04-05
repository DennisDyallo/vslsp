/**
 * E2E tests for the vslsp MCP server.
 *
 * These tests spawn the actual MCP server process via StdioClientTransport,
 * perform the MCP handshake, and call tools over the JSON-RPC protocol —
 * exercising the full stack from MCP tool registration through to diagnostics
 * collection and code structure mapping.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const MCP_ENTRY = join(PROJECT_ROOT, "mcp.ts");
const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/e2e-ts-project");

// Expected tool names — must match mcp.ts registerTool calls
const EXPECTED_TOOLS = [
  "get_diagnostics",
  "get_diagnostics_summary",
  "get_code_structure",
  "start_daemon",
  "get_daemon_status",
  "stop_daemon",
  "notify_file_changed",
  "verify_changes",
  "get_rust_diagnostics",
  "get_ts_diagnostics",
];

let client: Client;
let transport: StdioClientTransport;

/**
 * Parse the JSON text content from an MCP tool response.
 * MCP tools return { content: [{ type: "text", text: "..." }] }.
 */
function parseToolResult(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text);
}

/**
 * Assert that a parsed result conforms to the DiagnosticsResult schema.
 * Validates top-level fields and summary shape without checking specific values.
 */
function expectDiagnosticsResultSchema(data: any) {
  expect(data).toHaveProperty("solution");
  expect(typeof data.solution).toBe("string");
  expect(data).toHaveProperty("timestamp");
  expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601 prefix
  expect(typeof data.clean).toBe("boolean");
  expect(data.summary).toEqual(
    expect.objectContaining({
      errors: expect.any(Number),
      warnings: expect.any(Number),
      info: expect.any(Number),
      hints: expect.any(Number),
    })
  );
  expect(Array.isArray(data.files)).toBe(true);

  // clean must be consistent with error count
  if (data.summary.errors === 0) {
    expect(data.clean).toBe(true);
  } else {
    expect(data.clean).toBe(false);
  }
}

/**
 * Assert that a single diagnostic entry conforms to the DiagnosticEntry schema.
 */
function expectDiagnosticEntrySchema(
  diag: any,
  expectedSource: "tsc" | "rustc" | "csharp"
) {
  expect(["error", "warning", "info", "hint"]).toContain(diag.severity);
  expect(typeof diag.line).toBe("number");
  expect(diag.line).toBeGreaterThan(0);
  expect(typeof diag.column).toBe("number");
  expect(diag.column).toBeGreaterThan(0);
  // endLine, endColumn, code, source are optional per DiagnosticEntry type
  if (diag.endLine !== undefined) expect(typeof diag.endLine).toBe("number");
  if (diag.endColumn !== undefined) expect(typeof diag.endColumn).toBe("number");
  expect(typeof diag.message).toBe("string");
  expect(diag.message.length).toBeGreaterThan(0);
  if (diag.source !== undefined) expect(diag.source).toBe(expectedSource);
}

beforeAll(async () => {
  // Create a TS fixture project with intentional type errors
  mkdirSync(join(FIXTURE_DIR, "src"), { recursive: true });

  writeFileSync(
    join(FIXTURE_DIR, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2020",
        module: "ES2020",
        moduleResolution: "bundler",
        skipLibCheck: true,
      },
      include: ["src"],
    })
  );

  writeFileSync(
    join(FIXTURE_DIR, "src/broken.ts"),
    `const x: number = "not a number";\nfunction greet(name: string): number {\n  return name;\n}\n`
  );

  writeFileSync(
    join(FIXTURE_DIR, "src/clean.ts"),
    `export function add(a: number, b: number): number {\n  return a + b;\n}\n`
  );

  // Spawn MCP server and connect
  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", MCP_ENTRY],
    cwd: PROJECT_ROOT,
    stderr: "pipe",
  });

  client = new Client({ name: "e2e-test-client", version: "1.0.0" });
  await client.connect(transport);
}, 15_000);

afterAll(async () => {
  try {
    await client.close();
  } catch {
    // Server may already have exited
  }
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// --- Handshake & Discovery ---

describe("MCP Server Handshake", () => {
  test("server reports correct name and version", () => {
    const info = client.getServerVersion();
    expect(info).toBeDefined();
    expect(info!.name).toBe("vslsp");
    expect(info!.version).toBe("1.1.1");
  });

  test("tools/list returns all expected tools with valid schemas", async () => {
    const { tools } = await client.listTools();

    // Exact count
    expect(tools).toBeArrayOfSize(10);

    // All expected names present
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());

    // Every tool has description and a valid inputSchema
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

// --- TypeScript Diagnostics ---

describe("get_ts_diagnostics via MCP", () => {
  test("detects type errors in fixture project", async () => {
    const result = await client.callTool({
      name: "get_ts_diagnostics",
      arguments: { project: FIXTURE_DIR },
    });

    const data = parseToolResult(result);

    // Full schema conformance
    expectDiagnosticsResultSchema(data);
    expect(data.solution).toContain("tsconfig.json");

    // Should detect errors in broken.ts
    expect(data.clean).toBe(false);
    expect(data.summary.errors).toBeGreaterThanOrEqual(2);
    expect(data.files.length).toBeGreaterThanOrEqual(1);

    // Validate diagnostic entry structure on broken.ts
    const brokenFile = data.files.find((f: any) =>
      f.path.includes("broken.ts")
    );
    expect(brokenFile).toBeDefined();
    expect(brokenFile.diagnostics.length).toBeGreaterThanOrEqual(2);

    for (const diag of brokenFile.diagnostics) {
      expectDiagnosticEntrySchema(diag, "tsc");
      expect(diag.code).toMatch(/^TS\d+$/);
    }

    // Verify file-level structure (uri and path)
    expect(brokenFile.uri).toMatch(/^file:\/\//);
    expect(brokenFile.path).toContain("broken.ts");
  }, 30_000);

  test("file filter restricts results to matching file", async () => {
    const result = await client.callTool({
      name: "get_ts_diagnostics",
      arguments: { project: FIXTURE_DIR, file: "broken.ts" },
    });

    const data = parseToolResult(result);
    expect(data.files.length).toBe(1);
    expect(data.files[0].path).toContain("broken.ts");
    // Summary should only reflect the filtered file
    expect(data.summary.errors).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("clean project returns clean=true with zero errors", async () => {
    const result = await client.callTool({
      name: "get_ts_diagnostics",
      arguments: { project: FIXTURE_DIR, file: "clean.ts" },
    });

    const data = parseToolResult(result);
    // clean.ts has no errors — when filtered, there should be no error files
    // Note: the file filter happens after tsc runs, so broken.ts errors
    // are excluded from the result. clean.ts has no diagnostics so it
    // won't appear in files[] at all.
    expect(data.summary.errors).toBe(0);
    expect(data.clean).toBe(true);
  }, 30_000);

  test("returns error for nonexistent tsconfig", async () => {
    const result = await client.callTool({
      name: "get_ts_diagnostics",
      arguments: { project: "/nonexistent/path/to/project" },
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toContain("tsconfig.json not found");
  });
});

// --- Rust Diagnostics ---

describe("get_rust_diagnostics via MCP", () => {
  test("returns clean DiagnosticsResult for rust-mapper", async () => {
    const result = await client.callTool({
      name: "get_rust_diagnostics",
      arguments: { manifest: join(PROJECT_ROOT, "tools/rust-mapper") },
    });

    const data = parseToolResult(result);

    expectDiagnosticsResultSchema(data);
    expect(data.solution).toContain("Cargo.toml");
    // rust-mapper should compile cleanly
    expect(data.summary.errors).toBe(0);
    expect(data.clean).toBe(true);
  }, 60_000);

  test("returns error for nonexistent Cargo.toml", async () => {
    const result = await client.callTool({
      name: "get_rust_diagnostics",
      arguments: { manifest: "/nonexistent/rust/project" },
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toContain("Cargo.toml not found");
  });
});

// --- C# Diagnostics ---
// NOTE: get_diagnostics with a nonexistent .sln previously crashed the MCP server.
// The bug in LSPClient.start() has been fixed — spawn errors are now raced against
// initialize() so invalid .sln paths return a proper error response.

describe("get_diagnostics via MCP", () => {
  test("returns error for nonexistent .sln file", async () => {
    const result = await client.callTool({
      name: "get_diagnostics",
      arguments: {
        solution: "/nonexistent/solution.sln",
        timeout: 5000,
        quiet_period: 1000,
      },
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBeTruthy();
  }, 30_000);
});

// --- C# Diagnostics Summary ---

describe("get_diagnostics_summary via MCP", () => {
  test("returns error for nonexistent .sln file", async () => {
    const result = await client.callTool({
      name: "get_diagnostics_summary",
      arguments: { solution: "/nonexistent/solution.sln" },
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBeTruthy();
  }, 30_000);

  test("server survives get_diagnostics_summary error and handles subsequent calls", async () => {
    const errorResult = await client.callTool({
      name: "get_diagnostics_summary",
      arguments: { solution: "/nonexistent/summary.sln" },
    });
    expect(errorResult.isError).toBe(true);

    // Server must still respond to subsequent calls
    const statusResult = await client.callTool({
      name: "get_daemon_status",
      arguments: { port: 17852 },
    });
    const data = parseToolResult(statusResult);
    expect(data.status).toBe("not_running");
  }, 30_000);
});

// --- Code Structure ---

describe("get_code_structure via MCP", () => {
  test("analyzes TypeScript file and returns CodeMember schema", async () => {
    const result = await client.callTool({
      name: "get_code_structure",
      arguments: {
        path: join(PROJECT_ROOT, "src/core/types.ts"),
        format: "json",
        language: "typescript",
      },
    });

    const data = parseToolResult(result);

    // Top-level structure: { summary, files }
    expect(data).toHaveProperty("summary");
    expect(data).toHaveProperty("files");
    expect(Array.isArray(data.files)).toBe(true);
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.summary.types).toBeGreaterThan(0);

    // Each file has filePath and members
    const file = data.files[0];
    expect(file).toHaveProperty("filePath");
    expect(file).toHaveProperty("members");
    expect(Array.isArray(file.members)).toBe(true);
    expect(file.members.length).toBeGreaterThan(0);

    // Validate CodeMember schema — all fields must be present (no nulls per spec)
    const member = file.members[0];
    expect(member).toHaveProperty("type");
    expect(member).toHaveProperty("signature");
    expect(typeof member.signature).toBe("string");
    expect(member).toHaveProperty("lineNumber");
    expect(typeof member.lineNumber).toBe("number");
    expect(member.lineNumber).toBeGreaterThan(0);
    expect(member).toHaveProperty("isStatic");
    expect(typeof member.isStatic).toBe("boolean");
    expect(member).toHaveProperty("visibility");
    expect(member).toHaveProperty("docString");
    expect(typeof member.docString).toBe("string");
    expect(member).toHaveProperty("baseTypes");
    expect(Array.isArray(member.baseTypes)).toBe(true);
    expect(member).toHaveProperty("attributes");
    expect(Array.isArray(member.attributes)).toBe(true);
    expect(member).toHaveProperty("children");
    expect(Array.isArray(member.children)).toBe(true);
  }, 30_000);

  test("analyzes Rust file and returns CodeMember schema", async () => {
    const result = await client.callTool({
      name: "get_code_structure",
      arguments: {
        path: join(PROJECT_ROOT, "tools/rust-mapper/src/main.rs"),
        format: "json",
        language: "rust",
      },
    });

    const data = parseToolResult(result);

    expect(data).toHaveProperty("summary");
    expect(data).toHaveProperty("files");
    expect(data.files.length).toBeGreaterThan(0);

    // Find the file entry for main.rs (filePath may be relative or empty for single-file)
    const file = data.files.find((f: any) => f.filePath?.includes("main.rs")) ?? data.files[0];
    expect(file).toBeDefined();
    expect(file.members.length).toBeGreaterThan(0);

    // Validate at least one member has the full CodeMember shape
    const member = file.members[0];
    expect(member).toHaveProperty("type");
    expect(member).toHaveProperty("signature");
    expect(member).toHaveProperty("lineNumber");
    expect(member).toHaveProperty("visibility");
    expect(member).toHaveProperty("children");
  }, 30_000);

  test("auto-detects language from file extension", async () => {
    const result = await client.callTool({
      name: "get_code_structure",
      arguments: {
        path: join(PROJECT_ROOT, "src/core/types.ts"),
        format: "json",
        // language omitted — should auto-detect "typescript"
      },
    });

    expect(result.isError).toBeFalsy();
    const data = parseToolResult(result);
    expect(data.files.length).toBeGreaterThan(0);
  }, 30_000);

  test("returns error for nonexistent path", async () => {
    const result = await client.callTool({
      name: "get_code_structure",
      arguments: { path: "/nonexistent/file.ts" },
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBeTruthy();
  });
});

// --- Daemon Tools (No Live Daemon) ---

describe("daemon tools via MCP", () => {
  // Use unusual ports to avoid conflicts with any real daemon
  const UNUSED_PORT = 17850;

  test("get_daemon_status reports not_running when no daemon", async () => {
    const result = await client.callTool({
      name: "get_daemon_status",
      arguments: { port: UNUSED_PORT },
    });

    const data = parseToolResult(result);
    expect(data.status).toBe("not_running");
    expect(data.port).toBe(UNUSED_PORT);
  });

  test("stop_daemon returns error when no daemon is running", async () => {
    const result = await client.callTool({
      name: "stop_daemon",
      arguments: { port: UNUSED_PORT + 1 },
    });

    // stop_daemon calls stop() which throws DAEMON_NOT_RUNNING,
    // caught by the handler and returned as err()
    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toContain("daemon");
  });

  test("notify_file_changed with content returns error when no daemon is running", async () => {
    // Must provide content to bypass the local file existence check
    // and actually hit the daemon connection path
    const result = await client.callTool({
      name: "notify_file_changed",
      arguments: {
        file: "/some/file.cs",
        content: "class Foo {}",
        port: UNUSED_PORT + 2,
      },
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toContain("daemon");
  });

  test("notify_file_changed without content returns error for nonexistent file", async () => {
    const result = await client.callTool({
      name: "notify_file_changed",
      arguments: {
        file: "/nonexistent/file.cs",
        port: UNUSED_PORT + 2,
      },
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toContain("File not found");
  });

  test("verify_changes returns error when no daemon is running", async () => {
    const result = await client.callTool({
      name: "verify_changes",
      arguments: {
        changes: [{ file: "/some/file.cs", content: "class Foo {}" }],
        port: UNUSED_PORT + 3,
      },
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toContain("daemon");
  });
});

// --- Error Resilience ---

describe("server error resilience", () => {
  test("server survives multiple error responses and handles subsequent calls", async () => {
    // First error: bad TS project
    const tsError = await client.callTool({
      name: "get_ts_diagnostics",
      arguments: { project: "/nonexistent" },
    });
    expect(tsError.isError).toBe(true);

    // Second error: bad Rust manifest
    const rustError = await client.callTool({
      name: "get_rust_diagnostics",
      arguments: { manifest: "/nonexistent" },
    });
    expect(rustError.isError).toBe(true);

    // Third error: bad code structure path
    const structError = await client.callTool({
      name: "get_code_structure",
      arguments: { path: "/nonexistent" },
    });
    expect(structError.isError).toBe(true);

    // Valid request after three errors — server must still work
    const { tools } = await client.listTools();
    expect(tools).toBeArrayOfSize(10);

    // Valid tool call after errors — confirm full functionality
    const statusResult = await client.callTool({
      name: "get_daemon_status",
      arguments: { port: 17851 },
    });
    const data = parseToolResult(statusResult);
    expect(data.status).toBe("not_running");
  });
});

// --- Daemon Lifecycle Integration (requires real .sln) ---

describe("daemon lifecycle via MCP (integration)", () => {
  const SLN = process.env.FIRST_RESPONDER_SLN;
  const DAEMON_PORT = 17860; // dedicated port, avoids conflicts

  if (!SLN) {
    test.skip("FIRST_RESPONDER_SLN not set — skipping daemon lifecycle integration tests", () => {});
    return;
  }

  // Derive CS_FILE from the SLN directory so the path is portable
  const CS_FILE = process.env.FIRST_RESPONDER_CS_FILE ??
    join(SLN.replace(/\/[^/]+\.sln$/, ""), "src/FirstResponder.Cli/Theme.cs");

  test("start_daemon → ready → verify_changes → stop_daemon", async () => {
    // Start daemon
    const startResult = await client.callTool({
      name: "start_daemon",
      arguments: { solution: SLN, port: DAEMON_PORT },
    });
    expect(startResult.isError).toBeFalsy();
    const startData = parseToolResult(startResult);
    expect(startData.port).toBe(DAEMON_PORT);

    // Poll until ready
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      const statusResult = await client.callTool({
        name: "get_daemon_status",
        arguments: { port: DAEMON_PORT },
      });
      const statusData = parseToolResult(statusResult);
      if (statusData.ready === true) { ready = true; break; }
      await Bun.sleep(2000);
    }
    expect(ready).toBe(true);

    // verify_changes with a real .cs file
    const { readFileSync } = await import("fs");
    const content = readFileSync(CS_FILE, "utf8");
    const verifyResult = await client.callTool({
      name: "verify_changes",
      arguments: {
        changes: [{ file: CS_FILE, content }],
        port: DAEMON_PORT,
        settle_ms: 3000,
        timeout_ms: 30000,
      },
    });
    expect(verifyResult.isError).toBeFalsy();
    const verifyData = parseToolResult(verifyResult);
    expectDiagnosticsResultSchema(verifyData);

    // Stop daemon
    const stopResult = await client.callTool({
      name: "stop_daemon",
      arguments: { port: DAEMON_PORT },
    });
    expect(stopResult.isError).toBeFalsy();
    const stopData = parseToolResult(stopResult);
    expect(stopData.status).toBeDefined();
  }, 150_000);
});
