import { describe, test, expect } from "bun:test";

describe("HTTP server security configuration", () => {
  test("daemon binds to 127.0.0.1 — not accessible from LAN", async () => {
    const content = await Bun.file("src/diagnostics/http.ts").text();
    expect(content).toContain('hostname: "127.0.0.1"');
    // Must NOT bind to all interfaces
    expect(content).not.toContain("0.0.0.0");
  });

  test("no CORS wildcard headers — daemon is not browser-accessible", async () => {
    const content = await Bun.file("src/diagnostics/http.ts").text();
    // CORS was removed because daemon is only used by HTTP client, never browsers
    expect(content).not.toContain("Access-Control-Allow-Origin");
    expect(content).not.toContain("corsHeaders");
  });

  test("uses fileURLToPath for safe URI parsing — not naive slice", async () => {
    const content = await Bun.file("src/diagnostics/http.ts").text();
    expect(content).toContain("fileURLToPath");
    // Should NOT use the old unsafe pattern
    expect(content).not.toContain(".slice(7)");
  });
});

describe("LSP client crash safety", () => {
  test("error handler does not throw — uses reject instead", async () => {
    const content = await Bun.file("src/core/lsp-client.ts").text();

    // The process.on("error") handler must NOT throw
    // Extract the error handler block
    const errorHandlerMatch = content.match(/this\.process\.on\("error"[\s\S]*?\}\);/);
    expect(errorHandlerMatch).not.toBeNull();

    const handler = errorHandlerMatch![0];
    // Should use console.error and readyReject, NOT throw
    expect(handler).toContain("console.error");
    expect(handler).toContain("readyReject");
    expect(handler).not.toContain("throw ");
  });

  test("readyReject is wired into the ready promise", async () => {
    const content = await Bun.file("src/core/lsp-client.ts").text();
    expect(content).toContain("readyReject");
    // Promise creation should capture both resolve and reject
    expect(content).toContain("new Promise((resolve, reject)");
  });
});
