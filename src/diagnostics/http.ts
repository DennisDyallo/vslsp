import type { Server } from "bun";
import type { LSPClient } from "../core/lsp-client";
import type { DiagnosticsStore } from "./store";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { log } from "../core/logger";

export interface HttpServerOptions {
  port: number;
  client: LSPClient;
  store: DiagnosticsStore;
  solutionPath: string;
}

export function createHttpServer(options: HttpServerOptions) {
  const { port, client, store, solutionPath } = options;

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      try {
        // GET /health
        if (method === "GET" && path === "/health") {
          return Response.json({ status: "ok", pid: process.pid });
        }

        // GET /status
        if (method === "GET" && path === "/status") {
          return Response.json({
            solution: solutionPath,
            ready: client.isReady,
            updateCount: store.getUpdateCount(),
            lastUpdate: new Date(store.getLastUpdate()).toISOString(),
          });
        }

        // GET /diagnostics
        if (method === "GET" && path === "/diagnostics") {
          const file = url.searchParams.get("file");
          const result = file ? store.getByFile(file) : store.getAll();
          return Response.json(result);
        }

        // GET /diagnostics/summary
        if (method === "GET" && path === "/diagnostics/summary") {
          return Response.json(store.getSummary());
        }

        // POST /file-changed - notify file saved on disk
        if (method === "POST" && path === "/file-changed") {
          const body = await req.json() as { uri?: string; path?: string };
          const filePath = body.uri || body.path;
          if (!filePath) {
            return Response.json({ error: "Missing 'uri' or 'path' in body" }, { status: 400 });
          }

          const normalizedPath = filePath.startsWith("file://") ? fileURLToPath(filePath) : filePath;
          if (!existsSync(normalizedPath)) {
            return Response.json({ error: `File not found: ${normalizedPath}` }, { status: 404 });
          }

          await client.didSave(normalizedPath);
          return Response.json({ ok: true, action: "didSave", path: normalizedPath });
        }

        // POST /file-content - send content change without saving
        if (method === "POST" && path === "/file-content") {
          const body = await req.json() as { uri?: string; path?: string; content: string };
          const filePath = body.uri || body.path;
          if (!filePath) {
            return Response.json({ error: "Missing 'uri' or 'path' in body" }, { status: 400 });
          }
          if (typeof body.content !== "string") {
            return Response.json({ error: "Missing 'content' in body" }, { status: 400 });
          }

          const normalizedPath = filePath.startsWith("file://") ? fileURLToPath(filePath) : filePath;
          await client.didChange(normalizedPath, body.content);
          return Response.json({ ok: true, action: "didChange", path: normalizedPath });
        }

        // POST /stop
        if (method === "POST" && path === "/stop") {
          setTimeout(() => process.exit(0), 100);
          return Response.json({ ok: true, message: "Daemon stopping" });
        }

        // 404 for unknown routes
        return Response.json({ error: "Not found" }, { status: 404 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("error", "http error", { path, message });
        return Response.json({ error: message }, { status: 500 });
      }
    },
  });
}
