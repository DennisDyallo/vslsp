import { describe, test, expect } from "bun:test";
import { DiagnosticsStore } from "../../src/diagnostics/store";
import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";

function makeDiagParams(uri: string, diagnostics: Array<{
  message: string;
  severity?: 1 | 2 | 3 | 4;
  line?: number;
}>): PublishDiagnosticsParams {
  return {
    uri,
    diagnostics: diagnostics.map((d) => ({
      range: {
        start: { line: d.line ?? 0, character: 0 },
        end: { line: d.line ?? 0, character: 10 },
      },
      message: d.message,
      severity: d.severity ?? 1,
    })),
  };
}

describe("DiagnosticsStore — real-world scenarios", () => {
  test("accumulates diagnostics across multiple files like a real LSP session", () => {
    // Simulates: OmniSharp analyzing a solution and publishing diagnostics
    // file by file, as it does during initial load
    const store = new DiagnosticsStore("/Users/dev/MyProject/MyProject.sln");

    // First batch: OmniSharp reports errors in Program.cs
    store.handleDiagnostics(makeDiagParams(
      "file:///Users/dev/MyProject/Program.cs",
      [
        { message: "CS1002: ; expected", severity: 1, line: 15 },
        { message: "CS0246: type 'Foo' could not be found", severity: 1, line: 22 },
      ]
    ));

    // Second batch: warnings in a different file
    store.handleDiagnostics(makeDiagParams(
      "file:///Users/dev/MyProject/Services/UserService.cs",
      [
        { message: "CS0168: variable 'ex' declared but never used", severity: 2, line: 45 },
      ]
    ));

    const result = store.getAll();
    expect(result.summary.errors).toBe(2);
    expect(result.summary.warnings).toBe(1);
    expect(result.files).toHaveLength(2);
    expect(result.clean).toBe(false);
  });

  test("file filter by relative path does NOT match partial filename", () => {
    // Real scenario: agent queries diagnostics for "log.cs" and should NOT
    // get results for "changelog.cs" — this was an actual bug
    const store = new DiagnosticsStore("/test.sln");

    store.handleDiagnostics(makeDiagParams(
      "file:///project/src/changelog.cs",
      [{ message: "CS1002: ; expected" }]
    ));
    store.handleDiagnostics(makeDiagParams(
      "file:///project/src/log.cs",
      [{ message: "CS0246: type not found" }]
    ));
    store.handleDiagnostics(makeDiagParams(
      "file:///project/src/utils/log.cs",
      [{ message: "CS0168: unused variable" }]
    ));

    const result = store.getByFile("log.cs");

    // Should match src/log.cs and src/utils/log.cs but NOT changelog.cs
    expect(result.files).toHaveLength(2);
    const paths = result.files.map(f => f.path);
    expect(paths).not.toContain("/project/src/changelog.cs");
    expect(paths).toContain("/project/src/log.cs");
    expect(paths).toContain("/project/src/utils/log.cs");
  });

  test("file filter by full absolute path returns exact match", () => {
    const store = new DiagnosticsStore("/test.sln");

    store.handleDiagnostics(makeDiagParams(
      "file:///project/src/Foo.cs",
      [{ message: "error 1" }]
    ));
    store.handleDiagnostics(makeDiagParams(
      "file:///other/Foo.cs",
      [{ message: "error 2" }]
    ));

    // Full path should return exactly one file
    const result = store.getByFile("/project/src/Foo.cs");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("/project/src/Foo.cs");
  });

  test("diagnostics update replaces previous batch for same file", () => {
    // OmniSharp re-publishes all diagnostics for a file after each edit.
    // New publish should replace old, not accumulate.
    const store = new DiagnosticsStore("/test.sln");

    // Initial: 3 errors
    store.handleDiagnostics(makeDiagParams(
      "file:///src/Foo.cs",
      [
        { message: "error 1" },
        { message: "error 2" },
        { message: "error 3" },
      ]
    ));
    expect(store.getAll().summary.errors).toBe(3);

    // After fix: only 1 error remains
    store.handleDiagnostics(makeDiagParams(
      "file:///src/Foo.cs",
      [{ message: "error 3" }]
    ));
    expect(store.getAll().summary.errors).toBe(1);
    expect(store.getAll().files[0]!.diagnostics).toHaveLength(1);
  });

  test("empty diagnostics publish clears file — simulates successful fix", () => {
    // When all errors are fixed, OmniSharp publishes empty diagnostics array
    const store = new DiagnosticsStore("/test.sln");

    store.handleDiagnostics(makeDiagParams(
      "file:///src/Foo.cs",
      [{ message: "CS1002: ; expected" }]
    ));
    expect(store.getAll().files).toHaveLength(1);

    // User fixes the semicolon — OmniSharp publishes empty
    store.handleDiagnostics({ uri: "file:///src/Foo.cs", diagnostics: [] });
    expect(store.getAll().files).toHaveLength(0);
    expect(store.getAll().clean).toBe(true);
  });

  test("summary correctly categorizes mixed severities", () => {
    const store = new DiagnosticsStore("/test.sln");

    store.handleDiagnostics({
      uri: "file:///src/Mixed.cs",
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: "CS0246: type not found", severity: 1 },
        { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 5 } }, message: "CS0168: unused var", severity: 2 },
        { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } }, message: "IDE0059: unnecessary assignment", severity: 3 },
        { range: { start: { line: 15, character: 0 }, end: { line: 15, character: 5 } }, message: "IDE0060: remove unused param", severity: 4 },
      ],
    });

    const summary = store.getSummary();
    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(1);
    expect(summary.info).toBe(1);
    expect(summary.hints).toBe(1);
    // clean is based on error count only
    expect(summary.clean).toBe(false);
  });

  test("getByFile recalculates summary for filtered subset", () => {
    // When filtering by file, the summary should reflect only that file's diagnostics
    const store = new DiagnosticsStore("/test.sln");

    store.handleDiagnostics(makeDiagParams(
      "file:///src/A.cs",
      [{ message: "error in A", severity: 1 }]
    ));
    store.handleDiagnostics(makeDiagParams(
      "file:///src/B.cs",
      [
        { message: "error in B", severity: 1 },
        { message: "warning in B", severity: 2 },
      ]
    ));

    // Overall: 2 errors, 1 warning
    expect(store.getAll().summary.errors).toBe(2);

    // Filtered to A.cs: 1 error, 0 warnings
    const filtered = store.getByFile("A.cs");
    expect(filtered.summary.errors).toBe(1);
    expect(filtered.summary.warnings).toBe(0);
    expect(filtered.files).toHaveLength(1);
  });

  test("updateCount tracks daemon activity for settle detection", () => {
    // The verify_changes tool polls updateCount to detect when OmniSharp
    // has finished re-analyzing. Each publish increments it.
    const store = new DiagnosticsStore("/test.sln");
    expect(store.getUpdateCount()).toBe(0);

    store.handleDiagnostics(makeDiagParams("file:///a.cs", [{ message: "e1" }]));
    store.handleDiagnostics(makeDiagParams("file:///b.cs", [{ message: "e2" }]));
    store.handleDiagnostics({ uri: "file:///a.cs", diagnostics: [] }); // clear also counts

    expect(store.getUpdateCount()).toBe(3);
  });
});
