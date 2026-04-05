import { describe, test, expect } from "bun:test";
import { matchFilePath, severityToString, diagnosticToEntry } from "../../src/core/types";

describe("matchFilePath", () => {
  test("exact absolute path match", () => {
    expect(matchFilePath("/project/src/Foo.cs", "/project/src/Foo.cs")).toBe(true);
  });

  test("relative filename matches with path separator", () => {
    expect(matchFilePath("/project/src/Foo.cs", "Foo.cs")).toBe(true);
    expect(matchFilePath("/project/src/utils/Foo.cs", "Foo.cs")).toBe(true);
  });

  test("relative path with directory matches", () => {
    expect(matchFilePath("/project/src/Foo.cs", "src/Foo.cs")).toBe(true);
  });

  test("partial filename does NOT match — the changelog/log bug", () => {
    // This is the exact scenario that caused the bug:
    // "log.cs" should NOT match "changelog.cs"
    expect(matchFilePath("/project/src/changelog.cs", "log.cs")).toBe(false);
    expect(matchFilePath("/project/src/changelog.rs", "log.rs")).toBe(false);
    expect(matchFilePath("/project/src/catalog.ts", "log.ts")).toBe(false);
  });

  test("Windows backslash paths are normalized", () => {
    expect(matchFilePath("C:\\project\\src\\Foo.cs", "src/Foo.cs")).toBe(true);
    expect(matchFilePath("C:\\project\\src\\Foo.cs", "Foo.cs")).toBe(true);
  });

  test("empty filter matches nothing", () => {
    expect(matchFilePath("/project/src/Foo.cs", "")).toBe(false);
  });

  test("filter longer than path never matches", () => {
    expect(matchFilePath("/a.cs", "/very/long/path/a.cs")).toBe(false);
  });
});

describe("severityToString", () => {
  test("maps LSP severity numbers to string labels", () => {
    expect(severityToString(1)).toBe("error");
    expect(severityToString(2)).toBe("warning");
    expect(severityToString(3)).toBe("info");
    expect(severityToString(4)).toBe("hint");
    expect(severityToString(undefined)).toBe("info");
  });
});

describe("diagnosticToEntry", () => {
  test("converts LSP diagnostic with all fields", () => {
    const entry = diagnosticToEntry({
      range: {
        start: { line: 9, character: 4 },   // 0-indexed
        end: { line: 9, character: 15 },
      },
      message: "CS0246: type 'Foo' not found",
      severity: 1,
      code: "CS0246",
      source: "csharp",
    });

    // Should convert to 1-indexed
    expect(entry.line).toBe(10);
    expect(entry.column).toBe(5);
    expect(entry.endLine).toBe(10);
    expect(entry.endColumn).toBe(16);
    expect(entry.severity).toBe("error");
    expect(entry.code).toBe("CS0246");
    expect(entry.source).toBe("csharp");
    expect(entry.message).toBe("CS0246: type 'Foo' not found");
  });

  test("handles diagnostic with object-shaped code", () => {
    const entry = diagnosticToEntry({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: "test",
      code: { value: "CS1002" } as any,
    });

    expect(entry.code).toBe("CS1002");
  });
});
