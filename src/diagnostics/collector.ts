import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import { LSPClient } from "../core/lsp-client";
import {
  type DiagnosticsResult,
  type FileDiagnostics,
  type DiagnosticSummary,
  type LSPClientOptions,
  diagnosticToEntry,
} from "../core/types";
import { fileURLToPath } from "url";

export class DiagnosticsCollector {
  private client: LSPClient;
  private diagnosticsMap: Map<string, FileDiagnostics> = new Map();
  private lastUpdate: number = Date.now();
  private options: LSPClientOptions;

  constructor(options: LSPClientOptions) {
    this.options = options;
    this.client = new LSPClient(options);
  }

  async collect(): Promise<DiagnosticsResult> {
    this.client.onDiagnostics((params) => this.handleDiagnostics(params));

    await this.client.start();

    // Wait for diagnostics to settle (no new ones for quietPeriod)
    await this.waitForCompletion();

    await this.client.stop();

    return this.buildResult();
  }

  private handleDiagnostics(params: PublishDiagnosticsParams): void {
    this.lastUpdate = Date.now();

    const uri = params.uri;
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      path = uri.replace(/^file:\/\//, "");
    }

    if (params.diagnostics.length === 0) {
      // Clear diagnostics for this file
      this.diagnosticsMap.delete(uri);
    } else {
      this.diagnosticsMap.set(uri, {
        uri,
        path,
        diagnostics: params.diagnostics.map(diagnosticToEntry),
      });
    }
  }

  private async waitForCompletion(): Promise<void> {
    const startTime = Date.now();
    const MIN_WAIT = 10000; // Wait at least 10s for OmniSharp to load

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const timeSinceLastUpdate = Date.now() - this.lastUpdate;

        if (elapsed >= this.options.timeout) {
          clearInterval(checkInterval);
          resolve(); // Timeout reached, return what we have
        } else if (elapsed >= MIN_WAIT && timeSinceLastUpdate >= this.options.quietPeriod) {
          clearInterval(checkInterval);
          resolve(); // Quiet period reached, diagnostics are complete
        }
      }, 100);
    });
  }

  private buildResult(): DiagnosticsResult {
    const files = Array.from(this.diagnosticsMap.values())
      .filter((f) => f.diagnostics.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path));

    const summary: DiagnosticSummary = {
      errors: 0,
      warnings: 0,
      info: 0,
      hints: 0,
    };

    for (const file of files) {
      for (const diag of file.diagnostics) {
        switch (diag.severity) {
          case "error": summary.errors++; break;
          case "warning": summary.warnings++; break;
          case "info": summary.info++; break;
          case "hint": summary.hints++; break;
        }
      }
    }

    return {
      solution: this.options.solutionPath,
      timestamp: new Date().toISOString(),
      summary,
      clean: summary.errors === 0,
      files,
    };
  }
}
