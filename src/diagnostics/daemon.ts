import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { LSPClient } from "../core/lsp-client";
import { DiagnosticsStore } from "./store";
import { createHttpServer } from "./http";

interface ServeOptions {
  solution: string;
  port: number;
  omnisharpPath: string;
}

export async function serve(options: ServeOptions): Promise<void> {
  const solutionPath = resolve(options.solution);

  if (!existsSync(solutionPath)) {
    throw new Error(`Solution file not found: ${solutionPath}`);
  }

  if (!solutionPath.endsWith(".sln")) {
    throw new Error("Solution path must be a .sln file");
  }

  const omnisharpPath = resolve(options.omnisharpPath);
  if (!existsSync(omnisharpPath) && !existsSync(omnisharpPath + ".exe")) {
    throw new Error(
      `OmniSharp binary not found at: ${omnisharpPath}\n` +
      "Run 'bun run scripts/download-omnisharp.ts' to download it."
    );
  }

  console.error(`[vslsp] Starting daemon for ${solutionPath}`);
  console.error(`[vslsp] OmniSharp: ${omnisharpPath}`);

  const store = new DiagnosticsStore(solutionPath);

  const client = new LSPClient({
    solutionPath,
    omnisharpPath,
    timeout: 0, // Not used in daemon mode
    quietPeriod: 0, // Not used in daemon mode
  });

  // Wire up diagnostics handler
  client.onDiagnostics((params) => {
    store.handleDiagnostics(params);
  });

  // Start OmniSharp
  await client.start();
  console.error(`[vslsp] OmniSharp started, waiting for initial analysis...`);

  // Wait for initial diagnostics batch (use quiet period detection)
  const startTime = Date.now();
  const MIN_WAIT = 10000;
  const QUIET_PERIOD = 3000;

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const timeSinceUpdate = Date.now() - store.getLastUpdate();

      if (elapsed >= MIN_WAIT && timeSinceUpdate >= QUIET_PERIOD) {
        clearInterval(check);
        resolve();
      }

      // Max wait of 60s for initial load
      if (elapsed >= 60000) {
        clearInterval(check);
        resolve();
      }
    }, 500);
  });

  client.markReady();
  console.error(`[vslsp] Initial analysis complete. Files with diagnostics: ${store.getSummary().fileCount}`);

  // Start recursive file watcher for .cs files in solution directory
  const solutionDir = dirname(solutionPath);
  const recentlyChanged = new Map<string, number>(); // Debounce with timestamps

  // Use fs.watch with recursive: true - works on Linux with Bun
  const { watch, existsSync: fsExists, statSync } = require("fs");
  const { join, dirname: pathDirname, basename } = require("path");

  console.error(`[vslsp] Setting up watcher on: ${solutionDir}`);

  const watcher = watch(solutionDir, { recursive: true }, (event: string, relativePath: string | null) => {
    if (!relativePath) return;

    const fullPath = join(solutionDir, relativePath);

    // For .cs files, handle directly
    if (relativePath.endsWith(".cs")) {
      // Debounce - ignore changes within 500ms for same file
      const now = Date.now();
      const lastChange = recentlyChanged.get(fullPath) || 0;
      if (now - lastChange < 500) return;
      recentlyChanged.set(fullPath, now);

      // Check if file exists (events fire for deletes too)
      if (!fsExists(fullPath)) return;

      console.error(`[vslsp] File changed: ${fullPath}`);
      client.didSave(fullPath).catch((err) => {
        console.error(`[vslsp] Error notifying change: ${err}`);
      });
      return;
    }

    // For rename events on non-.cs files (like sed temp files), check if any
    // .cs file in that directory was just modified (atomic write detection)
    if (event === "rename") {
      const dir = join(solutionDir, pathDirname(relativePath));
      const tempBasename = basename(relativePath);

      // Only check if it looks like a temp file (sed uses sedXXXXXX pattern)
      if (tempBasename.startsWith("sed") || tempBasename.startsWith(".") || tempBasename.includes("~")) {
        // Find .cs files in this directory modified in last 2 seconds
        try {
          const { readdirSync } = require("fs");
          const files = readdirSync(dir);
          const now = Date.now();

          for (const file of files) {
            if (!file.endsWith(".cs")) continue;
            const csPath = join(dir, file);
            try {
              const stat = statSync(csPath);
              const mtime = stat.mtimeMs;
              // If file was modified in last 2 seconds
              if (now - mtime < 2000) {
                const lastChange = recentlyChanged.get(csPath) || 0;
                if (now - lastChange < 500) continue;
                recentlyChanged.set(csPath, now);

                console.error(`[vslsp] File changed (atomic write): ${csPath}`);
                client.didSave(csPath).catch((err) => {
                  console.error(`[vslsp] Error notifying change: ${err}`);
                });
              }
            } catch {
              // Ignore stat errors
            }
          }
        } catch {
          // Ignore readdir errors
        }
      }
    }
  });

  watcher.on('error', (err: Error) => {
    console.error(`[vslsp] Watcher error: ${err.message}`);
  });

  console.error(`[vslsp] Watching ${solutionDir} recursively for .cs file changes`);

  // Start HTTP server
  const server = createHttpServer({
    port: options.port,
    client,
    store,
    solutionPath,
  });

  console.error(`[vslsp] HTTP server listening on http://localhost:${options.port}`);
  console.error(`[vslsp] Endpoints:`);
  console.error(`  GET  /health           - Health check`);
  console.error(`  GET  /status           - OmniSharp status`);
  console.error(`  GET  /diagnostics      - All diagnostics`);
  console.error(`  GET  /diagnostics?file=X - Diagnostics for file`);
  console.error(`  GET  /diagnostics/summary - Counts only`);
  console.error(`  POST /file-changed     - Notify file saved`);
  console.error(`  POST /file-content     - Send file content`);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.error(`\n[vslsp] Shutting down...`);
    watcher.close();
    server.stop();
    await client.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}
