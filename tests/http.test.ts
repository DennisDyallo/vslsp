import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHttpServer } from "../src/diagnostics/http";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import type { Server } from "bun";

const TEST_PORT = 7860;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

/** Fetch JSON response body with proper typing for tests. */
async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

// Mock store — implements the methods http.ts actually calls
const mockStore = {
  getAll: () => ({
    files: [],
    summary: { errors: 0, warnings: 0, info: 0, hints: 0 },
    clean: true,
    solution: "/test/Solution.sln",
    timestamp: new Date().toISOString(),
  }),
  getByFile: (_file: string) => ({
    files: [],
    summary: { errors: 0, warnings: 0, info: 0, hints: 0 },
    clean: true,
    solution: "/test/Solution.sln",
    timestamp: new Date().toISOString(),
  }),
  getSummary: () => ({ errors: 0, warnings: 0, info: 0, hints: 0 }),
  getUpdateCount: () => 5,
  getLastUpdate: () => Date.now(),
};

// Mock client — implements LSP client methods used by http.ts
let lastDidSave: string | null = null;
let lastDidChange: { path: string; content: string } | null = null;
const mockClient = {
  isReady: true,
  didSave: async (path: string) => {
    lastDidSave = path;
  },
  didChange: async (path: string, content: string) => {
    lastDidChange = { path, content };
  },
};

let server: Server<unknown>;
let tempDir: string;
let originalExit: typeof process.exit;

beforeAll(() => {
  tempDir = join(tmpdir(), "vslsp-http-test-" + Date.now());
  mkdirSync(tempDir, { recursive: true });

  // Prevent process.exit from killing the test runner when testing /stop
  originalExit = process.exit;
  process.exit = (() => {}) as any;

  server = createHttpServer({
    port: TEST_PORT,
    client: mockClient as any,
    store: mockStore as any,
    solutionPath: "/test/Solution.sln",
  });
});

afterAll(() => {
  process.exit = originalExit;
  server.stop(true);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("HTTP server — real behavior", () => {
  describe("GET /health", () => {
    test("returns 200 with status=ok and numeric pid", async () => {
      const res = await fetch(`${BASE_URL}/health`);
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.status).toBe("ok");
      expect(typeof body.pid).toBe("number");
      expect(body.pid).toBeGreaterThan(0);
    });
  });

  describe("GET /status", () => {
    test("returns 200 with solution, ready, updateCount, and lastUpdate", async () => {
      const res = await fetch(`${BASE_URL}/status`);
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.solution).toBe("/test/Solution.sln");
      expect(body.ready).toBe(true);
      expect(typeof body.updateCount).toBe("number");
      expect(typeof body.lastUpdate).toBe("string");
      // lastUpdate should be ISO 8601
      expect(body.lastUpdate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("GET /diagnostics", () => {
    test("returns 200 with files array and summary", async () => {
      const res = await fetch(`${BASE_URL}/diagnostics`);
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(Array.isArray(body.files)).toBe(true);
      expect(body.clean).toBe(true);
      expect(body.summary.errors).toBe(0);
    });

    test("?file= query param filters by file", async () => {
      const res = await fetch(`${BASE_URL}/diagnostics?file=/some/File.cs`);
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(Array.isArray(body.files)).toBe(true);
    });
  });

  describe("GET /diagnostics/summary", () => {
    test("returns 200 with error/warning/info/hint counts", async () => {
      const res = await fetch(`${BASE_URL}/diagnostics/summary`);
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(typeof body.errors).toBe("number");
      expect(typeof body.warnings).toBe("number");
      expect(typeof body.info).toBe("number");
      expect(typeof body.hints).toBe("number");
    });
  });

  describe("POST /file-changed", () => {
    test("returns 200 with ok:true and didSave action for a real file", async () => {
      const tempFile = join(tempDir, "test.cs");
      writeFileSync(tempFile, "class Foo {}");

      const res = await fetch(`${BASE_URL}/file-changed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tempFile }),
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.ok).toBe(true);
      expect(body.action).toBe("didSave");
      expect(body.path).toBe(tempFile);
      // Verify the mock client received the didSave call
      expect(lastDidSave).not.toBeNull();
      expect(lastDidSave!).toBe(tempFile);
    });

    test("accepts file:// URI and normalizes path", async () => {
      const tempFile = join(tempDir, "test-uri.cs");
      writeFileSync(tempFile, "class Bar {}");
      const uri = `file://${tempFile}`;

      const res = await fetch(`${BASE_URL}/file-changed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri }),
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.path).toBe(tempFile);
    });

    test("missing path and uri returns 400", async () => {
      const res = await fetch(`${BASE_URL}/file-changed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.error).toContain("Missing");
    });

    test("nonexistent file returns 404", async () => {
      const res = await fetch(`${BASE_URL}/file-changed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/nonexistent/file.cs" }),
      });
      expect(res.status).toBe(404);
      const body = await jsonBody(res);
      expect(body.error).toContain("not found");
    });
  });

  describe("POST /file-content", () => {
    test("returns 200 with ok:true and didChange action", async () => {
      const content = "const x = 42;";
      lastDidChange = null;

      const res = await fetch(`${BASE_URL}/file-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/virtual/file.ts", content }),
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.ok).toBe(true);
      expect(body.action).toBe("didChange");
      expect(body.path).toBe("/virtual/file.ts");
      expect(lastDidChange!.content).toBe(content);
    });

    test("missing content returns 400", async () => {
      const res = await fetch(`${BASE_URL}/file-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/virtual/file.ts" }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.error).toContain("Missing");
    });

    test("missing path returns 400", async () => {
      const res = await fetch(`${BASE_URL}/file-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.error).toContain("Missing");
    });
  });

  describe("unknown routes", () => {
    test("returns 404 with error field", async () => {
      const res = await fetch(`${BASE_URL}/unknown-route`);
      expect(res.status).toBe(404);
      const body = await jsonBody(res);
      expect(body.error).toBeTruthy();
    });
  });

  describe("security", () => {
    test("server binds to localhost only", async () => {
      expect(server.hostname).toBe("127.0.0.1");
    });

    test("response headers do not include CORS Access-Control-Allow-Origin", async () => {
      const res = await fetch(`${BASE_URL}/health`);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("POST /stop", () => {
    test("returns 200 with ok:true and stopping message", async () => {
      const res = await fetch(`${BASE_URL}/stop`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.ok).toBe(true);
      expect(body.message).toContain("stopping");
    });
  });
});
