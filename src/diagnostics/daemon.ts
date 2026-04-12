import { existsSync, watch, statSync, readdirSync } from "fs";
import { resolve, dirname, join, basename } from "path";
import { LSPClient } from "../core/lsp-client";
import { DiagnosticsStore } from "./store";
import { createHttpServer } from "./http";
import { type DaemonLanguage, getLanguageConfig } from "../core/language";
import { Glob } from "bun";

interface ServeOptions {
  manifestPath: string;
  port: number;
  language: DaemonLanguage;
}

export async function serve(options: ServeOptions): Promise<void> {
  const manifestPath = resolve(options.manifestPath);
  const config = getLanguageConfig(options.language);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  config.manifestValidator(manifestPath);

  const serverBinary = config.resolveServerBinary();
  if (!existsSync(serverBinary) && !existsSync(serverBinary + ".exe")) {
    throw new Error(
      `LSP server binary not found at: ${serverBinary}\n` +
      `Language: ${options.language}`
    );
  }

  console.error(`[vslsp] Starting ${options.language} daemon for ${manifestPath}`);
  console.error(`[vslsp] LSP server: ${serverBinary}`);

  const store = new DiagnosticsStore(manifestPath);

  const client = new LSPClient({
    manifestPath,
    serverBinary,
    serverArgs: config.serverArgs(manifestPath),
    languageId: config.languageId,
    rootUri: config.rootUri(manifestPath),
    timeout: 0, // Not used in daemon mode
    quietPeriod: 0, // Not used in daemon mode
    ...(config.initializationOptions
      ? { initializationOptions: config.initializationOptions(manifestPath) }
      : {}),
  });

  // Wire up diagnostics handler
  client.onDiagnostics((params) => {
    store.handleDiagnostics(params);
  });

  // Start LSP server
  await client.start();
  console.error(`[vslsp] LSP server started, waiting for initial analysis...`);

  // TypeScript and Rust language servers need files to be opened before
  // workspace/symbol works. Open entry files from the project to bootstrap.
  if (options.language === "typescript" || options.language === "rust") {
    const rootDir = dirname(manifestPath);
    const patterns = options.language === "typescript"
      ? ["**/*.ts", "**/*.tsx"]
      : ["**/*.rs"];
    const EXCLUDED_SEGMENTS = new Set(["node_modules", "target", ".git", "dist"]);

    let opened = 0;
    const MAX_BOOTSTRAP_FILES = 50;
    for (const pattern of patterns) {
      const glob = new Glob(pattern);
      for (const match of glob.scanSync({ cwd: rootDir, absolute: true })) {
        if (match.split("/").some(seg => EXCLUDED_SEGMENTS.has(seg))) continue;
        if (opened >= MAX_BOOTSTRAP_FILES) break;
        try {
          await client.didOpen(match);
          opened++;
        } catch (e) {
          console.error(`[vslsp] Bootstrap didOpen error for ${match}: ${e}`);
        }
      }
      if (opened >= MAX_BOOTSTRAP_FILES) break;
    }
    console.error(`[vslsp] Bootstrapped ${opened} files for ${options.language} workspace`);
  }

  // Wait for initial diagnostics batch (use quiet period detection)
  const startTime = Date.now();
  const MIN_WAIT = config.minWaitMs;
  const QUIET_PERIOD = config.quietPeriodMs;

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

  // Start recursive file watcher for source files in project directory
  const rootDir = dirname(manifestPath);
  const recentlyChanged = new Map<string, number>(); // Debounce with timestamps

  // Periodically prune stale debounce entries to prevent unbounded growth
  const DEBOUNCE_CLEANUP_MS = 60_000;
  const DEBOUNCE_STALE_MS = 5_000;
  const debounceCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of recentlyChanged) {
      if (now - ts > DEBOUNCE_STALE_MS) recentlyChanged.delete(key);
    }
  }, DEBOUNCE_CLEANUP_MS);

  const matchesWatchExtension = (path: string) =>
    config.watchExtensions.some(ext => path.endsWith(ext));

  // Use fs.watch with recursive: true - works on Linux with Bun

  console.error(`[vslsp] Setting up watcher on: ${rootDir}`);

  const watcher = watch(rootDir, { recursive: true }, (event: string, relativePath: string | null) => {
    if (!relativePath) return;

    const fullPath = join(rootDir, relativePath);

    // For source files matching watch extensions, handle directly
    if (matchesWatchExtension(relativePath)) {
      // Debounce - ignore changes within 500ms for same file
      const now = Date.now();
      const lastChange = recentlyChanged.get(fullPath) || 0;
      if (now - lastChange < 500) return;
      recentlyChanged.set(fullPath, now);

      // Check if file exists (events fire for deletes too)
      if (!existsSync(fullPath)) return;

      console.error(`[vslsp] File changed: ${fullPath}`);
      client.didSave(fullPath).catch((err) => {
        console.error(`[vslsp] Error notifying change: ${err}`);
      });
      return;
    }

    // For rename events on non-source files (like sed temp files), check if any
    // source file in that directory was just modified (atomic write detection)
    if (event === "rename") {
      const dir = join(rootDir, dirname(relativePath));
      const tempBasename = basename(relativePath);

      // Only check if it looks like a temp file (sed uses sedXXXXXX pattern)
      if (tempBasename.startsWith("sed") || tempBasename.startsWith(".") || tempBasename.includes("~")) {
        // Find source files in this directory modified in last 2 seconds
        try {
          const files = readdirSync(dir);
          const now = Date.now();

          for (const file of files) {
            if (!matchesWatchExtension(file)) continue;
            const sourcePath = join(dir, file);
            try {
              const stat = statSync(sourcePath);
              const mtime = stat.mtimeMs;
              // If file was modified in last 2 seconds
              if (now - mtime < 2000) {
                const lastChange = recentlyChanged.get(sourcePath) || 0;
                if (now - lastChange < 500) continue;
                recentlyChanged.set(sourcePath, now);

                console.error(`[vslsp] File changed (atomic write): ${sourcePath}`);
                client.didSave(sourcePath).catch((err) => {
                  console.error(`[vslsp] Error notifying change: ${err}`);
                });
              }
            } catch (e) {
              console.error(`[vslsp] stat error during atomic write detection: ${e}`);
            }
          }
        } catch (e) {
          console.error(`[vslsp] readdir error during atomic write detection: ${e}`);
        }
      }
    }
  });

  watcher.on('error', (err: Error) => {
    console.error(`[vslsp] Watcher error: ${err.message}`);
  });

  const extList = config.watchExtensions.join(", ");
  console.error(`[vslsp] Watching ${rootDir} recursively for ${extList} file changes`);

  // Start HTTP server
  const server = createHttpServer({
    port: options.port,
    client,
    store,
    solutionPath: manifestPath,
  });

  console.error(`[vslsp] HTTP server listening on http://localhost:${options.port}`);
  console.error(`[vslsp] Endpoints:`);
  console.error(`  GET  /health           - Health check`);
  console.error(`  GET  /status           - LSP server status`);
  console.error(`  GET  /diagnostics      - All diagnostics`);
  console.error(`  GET  /diagnostics?file=X - Diagnostics for file`);
  console.error(`  GET  /diagnostics/summary - Counts only`);
  console.error(`  POST /file-changed     - Notify file saved`);
  console.error(`  POST /file-content     - Send file content`);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.error(`\n[vslsp] Shutting down...`);
    clearInterval(debounceCleanup);
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
