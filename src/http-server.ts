import type { Server } from "bun";
import type { LSPClient } from "./lsp-client";
import type { DiagnosticsStore } from "./diagnostics-store";
import { existsSync, readFileSync } from "fs";

export interface HttpServerOptions {
  port: number;
  client: LSPClient;
  store: DiagnosticsStore;
  solutionPath: string;
}

export function createHttpServer(options: HttpServerOptions) {
  const { port, client, store, solutionPath } = options;

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // CORS headers for local development
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // GET /health
        if (method === "GET" && path === "/health") {
          return Response.json({ status: "ok", pid: process.pid }, { headers: corsHeaders });
        }

        // GET /status
        if (method === "GET" && path === "/status") {
          return Response.json({
            solution: solutionPath,
            ready: client.isReady,
            updateCount: store.getUpdateCount(),
            lastUpdate: new Date(store.getLastUpdate()).toISOString(),
          }, { headers: corsHeaders });
        }

        // GET /diagnostics
        if (method === "GET" && path === "/diagnostics") {
          const file = url.searchParams.get("file");
          const result = file ? store.getByFile(file) : store.getAll();
          return Response.json(result, { headers: corsHeaders });
        }

        // GET /diagnostics/summary
        if (method === "GET" && path === "/diagnostics/summary") {
          return Response.json(store.getSummary(), { headers: corsHeaders });
        }

        // POST /file-changed - notify file saved on disk
        if (method === "POST" && path === "/file-changed") {
          const body = await req.json() as { uri?: string; path?: string };
          const filePath = body.uri || body.path;
          if (!filePath) {
            return Response.json({ error: "Missing 'uri' or 'path' in body" }, { status: 400, headers: corsHeaders });
          }

          const normalizedPath = filePath.startsWith("file://") ? filePath.slice(7) : filePath;
          if (!existsSync(normalizedPath)) {
            return Response.json({ error: `File not found: ${normalizedPath}` }, { status: 404, headers: corsHeaders });
          }

          await client.didSave(normalizedPath);
          return Response.json({ ok: true, action: "didSave", path: normalizedPath }, { headers: corsHeaders });
        }

        // POST /file-content - send content change without saving
        if (method === "POST" && path === "/file-content") {
          const body = await req.json() as { uri?: string; path?: string; content: string };
          const filePath = body.uri || body.path;
          if (!filePath) {
            return Response.json({ error: "Missing 'uri' or 'path' in body" }, { status: 400, headers: corsHeaders });
          }
          if (typeof body.content !== "string") {
            return Response.json({ error: "Missing 'content' in body" }, { status: 400, headers: corsHeaders });
          }

          const normalizedPath = filePath.startsWith("file://") ? filePath.slice(7) : filePath;
          await client.didChange(normalizedPath, body.content);
          return Response.json({ ok: true, action: "didChange", path: normalizedPath }, { headers: corsHeaders });
        }

        // 404 for unknown routes
        return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 500, headers: corsHeaders });
      }
    },
  });
}
