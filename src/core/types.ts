import type { Diagnostic, DiagnosticSeverity } from "vscode-languageserver-protocol";

export interface DiagnosticEntry {
  severity: "error" | "warning" | "info" | "hint";
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  code?: string | number;
  source?: string;
}

export interface FileDiagnostics {
  uri: string;
  path: string;
  diagnostics: DiagnosticEntry[];
}

export interface DiagnosticSummary {
  errors: number;
  warnings: number;
  info: number;
  hints: number;
}

export interface DiagnosticsResult {
  solution: string;
  timestamp: string;
  summary: DiagnosticSummary;
  clean: boolean;
  files: FileDiagnostics[];
}

export interface LSPClientOptions {
  solutionPath: string;
  omnisharpPath: string;
  timeout: number;
  quietPeriod: number; // ms to wait after last diagnostic before considering scan complete
}

export function severityToString(severity: DiagnosticSeverity | undefined): DiagnosticEntry["severity"] {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "info";
  }
}

export function diagnosticToEntry(diag: Diagnostic): DiagnosticEntry {
  let code: string | number | undefined;
  if (diag.code !== undefined) {
    if (typeof diag.code === "object" && diag.code !== null && "value" in diag.code) {
      code = (diag.code as { value: string | number }).value;
    } else if (typeof diag.code === "string" || typeof diag.code === "number") {
      code = diag.code;
    }
  }
  return {
    severity: severityToString(diag.severity),
    line: diag.range.start.line + 1,
    column: diag.range.start.character + 1,
    endLine: diag.range.end.line + 1,
    endColumn: diag.range.end.character + 1,
    message: diag.message,
    code,
    source: diag.source,
  };
}
