import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import { fileURLToPath } from "url";
import {
  type DiagnosticsResult,
  type FileDiagnostics,
  type DiagnosticSummary,
  diagnosticToEntry,
} from "../core/types";

export class DiagnosticsStore {
  private diagnosticsMap: Map<string, FileDiagnostics> = new Map();
  private solutionPath: string;
  private lastUpdate: number = Date.now();
  private updateCount: number = 0;

  constructor(solutionPath: string) {
    this.solutionPath = solutionPath;
  }

  handleDiagnostics(params: PublishDiagnosticsParams): void {
    this.lastUpdate = Date.now();
    this.updateCount++;

    const uri = params.uri;
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      path = uri.replace(/^file:\/\//, "");
    }

    if (params.diagnostics.length === 0) {
      this.diagnosticsMap.delete(uri);
    } else {
      this.diagnosticsMap.set(uri, {
        uri,
        path,
        diagnostics: params.diagnostics.map(diagnosticToEntry),
      });
    }
  }

  getAll(): DiagnosticsResult {
    return this.buildResult();
  }

  getByFile(filePath: string): DiagnosticsResult {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const result = this.buildResult();
    result.files = result.files.filter((f) => {
      const fPath = f.path.replace(/\\/g, "/");
      return fPath === normalizedPath || fPath.endsWith(normalizedPath);
    });
    // Recalculate summary for filtered files
    result.summary = this.calculateSummary(result.files);
    result.clean = result.summary.errors === 0;
    return result;
  }

  getSummary(): DiagnosticSummary & { clean: boolean; fileCount: number; lastUpdate: string } {
    const summary = this.calculateSummary(Array.from(this.diagnosticsMap.values()));
    return {
      ...summary,
      clean: summary.errors === 0,
      fileCount: this.diagnosticsMap.size,
      lastUpdate: new Date(this.lastUpdate).toISOString(),
    };
  }

  getUpdateCount(): number {
    return this.updateCount;
  }

  getLastUpdate(): number {
    return this.lastUpdate;
  }

  clear(): void {
    this.diagnosticsMap.clear();
    this.updateCount = 0;
  }

  private buildResult(): DiagnosticsResult {
    const files = Array.from(this.diagnosticsMap.values())
      .filter((f) => f.diagnostics.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path));

    const summary = this.calculateSummary(files);

    return {
      solution: this.solutionPath,
      timestamp: new Date().toISOString(),
      summary,
      clean: summary.errors === 0,
      files,
    };
  }

  private calculateSummary(files: FileDiagnostics[]): DiagnosticSummary {
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

    return summary;
  }
}
