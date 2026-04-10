import type { Server } from "bun";
import type { LSPClient } from "../core/lsp-client";
import type { DiagnosticsStore } from "./store";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { log } from "../core/logger";
import { symbolKindToString } from "../core/types";

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

        // GET /symbol?query=X&kind=Y&limit=N
        if (method === "GET" && path === "/symbol") {
          const query = url.searchParams.get("query");
          if (!query) {
            return Response.json({ error: "Missing 'query' parameter" }, { status: 400 });
          }
          const kindFilter = url.searchParams.get("kind");
          const rawLimit = parseInt(url.searchParams.get("limit") ?? "50");
          const limit = isNaN(rawLimit) ? 50 : rawLimit;

          const rawSymbols = await client.workspaceSymbol(query);
          let symbols = rawSymbols.map((s: any) => ({
            name: s.name,
            kind: symbolKindToString(s.kind),
            file: s.location?.uri ? fileURLToPath(s.location.uri) : "",
            line: (s.location?.range?.start?.line ?? 0) + 1,
            column: (s.location?.range?.start?.character ?? 0) + 1,
            containerName: s.containerName || undefined,
          }));

          if (kindFilter && kindFilter !== "all") {
            symbols = symbols.filter((s: any) => s.kind.toLowerCase() === kindFilter.toLowerCase());
          }

          symbols = symbols.slice(0, limit);
          return Response.json({ symbols, count: symbols.length });
        }

        // GET /references?file=X&line=Y&column=Z
        if (method === "GET" && path === "/references") {
          const file = url.searchParams.get("file");
          const line = url.searchParams.get("line");
          const column = url.searchParams.get("column");

          if (!file || !line || !column) {
            return Response.json({ error: "Missing file, line, or column parameter" }, { status: 400 });
          }

          const parsedLine = parseInt(line);
          const parsedColumn = parseInt(column);
          if (isNaN(parsedLine) || isNaN(parsedColumn)) {
            return Response.json({ error: "line and column must be numeric" }, { status: 400 });
          }

          const refs = await client.references(file, parsedLine, parsedColumn);

          const normalizedFile = file.startsWith("file://") ? fileURLToPath(file) : file;
          const allLocations = refs.map((r: any) => ({
            file: r.uri ? fileURLToPath(r.uri) : "",
            line: (r.range?.start?.line ?? 0) + 1,
            column: (r.range?.start?.character ?? 0) + 1,
            endLine: (r.range?.end?.line ?? 0) + 1,
            endColumn: (r.range?.end?.character ?? 0) + 1,
          }));

          // Identify definition: the location matching the queried position
          const defIdx = allLocations.findIndex((loc: any) =>
            loc.file === normalizedFile && loc.line === parsedLine
          );
          const definition = defIdx >= 0 ? allLocations[defIdx] : undefined;
          const usages = allLocations.filter((_: any, i: number) => i !== defIdx);

          return Response.json({ definition, usages, count: allLocations.length });
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
