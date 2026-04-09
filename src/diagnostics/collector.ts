import { LSPClient } from "../core/lsp-client";
import {
  type DiagnosticsResult,
  type LSPClientOptions,
} from "../core/types";
import { existsSync } from "fs";
import { resolve } from "path";
import { DiagnosticsStore } from "./store";

export class DiagnosticsCollector {
  private client: LSPClient;
  private store: DiagnosticsStore;
  private options: LSPClientOptions;

  constructor(options: LSPClientOptions) {
    this.options = options;
    this.client = new LSPClient(options);
    this.store = new DiagnosticsStore(options.solutionPath);
  }

  async collect(): Promise<DiagnosticsResult> {
    const solutionPath = resolve(this.options.solutionPath);
    if (!existsSync(solutionPath)) {
      throw new Error(`Solution file not found: ${solutionPath}`);
    }

    this.client.onDiagnostics((params) => this.store.handleDiagnostics(params));

    await this.client.start();

    // Wait for diagnostics to settle (no new ones for quietPeriod)
    await this.waitForCompletion();

    await this.client.stop();

    return this.store.getAll();
  }

  private async waitForCompletion(): Promise<void> {
    const startTime = Date.now();
    const MIN_WAIT = 10000; // Wait at least 10s for OmniSharp to load

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const timeSinceLastUpdate = Date.now() - this.store.getLastUpdate();

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
}
