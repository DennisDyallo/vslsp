import { spawn, type ChildProcess } from "child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  type InitializeParams,
  type PublishDiagnosticsParams,
} from "vscode-languageserver-protocol";
import type { LSPClientOptions } from "./types";
import { readFileSync } from "fs";

export class LSPClient {
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private diagnosticsHandler: ((params: PublishDiagnosticsParams) => void) | null = null;
  private openDocuments: Map<string, number> = new Map(); // uri -> version
  private _isReady: boolean = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(private options: LSPClientOptions) {}

  get isReady(): boolean {
    return this._isReady;
  }

  async waitUntilReady(): Promise<void> {
    if (this._isReady) return;
    if (this.readyPromise) return this.readyPromise;
    return Promise.resolve();
  }

  async start(): Promise<void> {
    const args = ["-lsp", "-s", this.options.solutionPath];

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Explicitly pass process.env — Bun compiled binaries do not always propagate
    // the full environment to grandchild processes via child_process.spawn without it.
    this.process = spawn(this.options.omnisharpPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error("Failed to create OmniSharp process streams");
    }

    this.process.stderr?.on("data", (data) => {
      const text = data.toString().trim();
      if (text) console.error(`[LSP/stderr] ${text}`);
    });

    let spawnReject!: (err: Error) => void;
    const spawnFailed = new Promise<never>((_, reject) => {
      spawnReject = reject;
    });

    this.process.on("error", (err) => {
      console.error(`[LSP] OmniSharp process error: ${err.message}`);
      this._isReady = false;
      const error = new Error(`OmniSharp process error: ${err.message}`);
      this.readyReject?.(error);
      spawnReject(error);
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin)
    );

    // Register diagnostics handler before starting
    this.connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
      this.diagnosticsHandler?.(params);
    });

    this.connection.listen();

    // Race initialize() against spawn error — if OmniSharp fails to start,
    // spawnFailed rejects immediately and we propagate the error instead of
    // sending requests on dead streams (which would crash the MCP server).
    const initPromise = this.initialize();
    await Promise.race([initPromise, spawnFailed]);
    // Suppress the eventual rejection of initPromise if spawnFailed won the race
    initPromise.catch(() => {});
    // Suppress the rejection of spawnFailed if initPromise won the race
    spawnFailed.catch(() => {});
  }

  markReady(): void {
    this._isReady = true;
    this.readyResolve?.();
  }

  private async initialize(): Promise<void> {
    if (!this.connection) throw new Error("Connection not established");

    const initParams: InitializeParams = {
      processId: process.pid,
      rootUri: `file://${this.options.solutionPath.replace(/[^/\\]+$/, "")}`,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: false,
            tagSupport: { valueSet: [1, 2] },
            codeDescriptionSupport: true,
            dataSupport: true,
          },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      workspaceFolders: null,
    };

    await this.connection.sendRequest("initialize", initParams);
    await this.connection.sendNotification("initialized", {});
  }

  onDiagnostics(handler: (params: PublishDiagnosticsParams) => void): void {
    this.diagnosticsHandler = handler;
  }

  // Text document sync methods for daemon mode
  async didOpen(uri: string, content?: string): Promise<void> {
    if (!this.connection) throw new Error("Connection not established");

    const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;
    if (this.openDocuments.has(fileUri)) return; // Already open

    let text = content;
    if (!text) {
      const path = uri.startsWith("file://") ? uri.slice(7) : uri;
      text = readFileSync(path, "utf-8");
    }

    console.error(`[LSP] didOpen: ${fileUri} (${text.length} chars)`);
    this.openDocuments.set(fileUri, 1);
    await this.connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: fileUri,
        languageId: "csharp",
        version: 1,
        text,
      },
    });
  }

  async didChange(uri: string, content: string): Promise<void> {
    if (!this.connection) throw new Error("Connection not established");

    const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;

    // Auto-open if not already open
    if (!this.openDocuments.has(fileUri)) {
      await this.didOpen(uri, content);
      // Now send didChange with updated content
    }

    const version = (this.openDocuments.get(fileUri) || 0) + 1;
    this.openDocuments.set(fileUri, version);

    console.error(`[LSP] didChange: ${fileUri} v${version} (${content.length} chars)`);
    await this.connection.sendNotification("textDocument/didChange", {
      textDocument: {
        uri: fileUri,
        version,
      },
      contentChanges: [{ text: content }],
    });
  }

  async didSave(uri: string): Promise<void> {
    if (!this.connection) throw new Error("Connection not established");

    const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;

    // Read fresh content from disk
    const path = uri.startsWith("file://") ? uri.slice(7) : uri;
    const text = readFileSync(path, "utf-8");

    // If file wasn't open, open it first
    if (!this.openDocuments.has(fileUri)) {
      await this.didOpen(uri, text);
      // Force re-analysis by sending didChange after didOpen
      // OmniSharp may not analyze on didOpen alone
      const version = (this.openDocuments.get(fileUri) || 0) + 1;
      this.openDocuments.set(fileUri, version);
      console.error(`[LSP] didChange (post-open): ${fileUri} v${version}`);
      await this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri: fileUri, version },
        contentChanges: [{ text }],
      });
    } else {
      // Update with disk content
      const version = (this.openDocuments.get(fileUri) || 0) + 1;
      this.openDocuments.set(fileUri, version);
      await this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri: fileUri, version },
        contentChanges: [{ text }],
      });
    }

    await this.connection.sendNotification("textDocument/didSave", {
      textDocument: { uri: fileUri },
      text,
    });
  }

  async didClose(uri: string): Promise<void> {
    if (!this.connection) throw new Error("Connection not established");

    const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;
    if (!this.openDocuments.has(fileUri)) return;

    this.openDocuments.delete(fileUri);
    await this.connection.sendNotification("textDocument/didClose", {
      textDocument: { uri: fileUri },
    });
  }

  async stop(): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.sendRequest("shutdown");
        await this.connection.sendNotification("exit");
      } catch {
        // Ignore errors during shutdown
      }
      this.connection.dispose();
      this.connection = null;
    }

    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }
}
