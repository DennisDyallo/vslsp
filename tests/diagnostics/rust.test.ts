import { describe, test, expect } from "bun:test";
import { collectRustDiagnostics } from "../../src/diagnostics/rust";

describe("collectRustDiagnostics", () => {
  test("throws when Cargo.toml not found", async () => {
    await expect(
      collectRustDiagnostics({ manifest: "/nonexistent/path" })
    ).rejects.toThrow("Cargo.toml not found");
  });

  test("returns DiagnosticsResult schema for rust-mapper", async () => {
    const result = await collectRustDiagnostics({
      manifest: "tools/rust-mapper/Cargo.toml",
    });

    expect(result).toHaveProperty("solution");
    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("clean");
    expect(result).toHaveProperty("files");

    expect(result.summary).toHaveProperty("errors");
    expect(result.summary).toHaveProperty("warnings");
    expect(result.summary).toHaveProperty("info");
    expect(result.summary).toHaveProperty("hints");

    expect(typeof result.solution).toBe("string");
    expect(result.solution).toContain("Cargo.toml");
    expect(typeof result.timestamp).toBe("string");
    expect(typeof result.clean).toBe("boolean");
    expect(Array.isArray(result.files)).toBe(true);

    expect(result.clean).toBe(true);
  }, 30_000);

  test("file filter excludes non-matching files", async () => {
    const result = await collectRustDiagnostics({
      manifest: "tools/rust-mapper/Cargo.toml",
      file: "nonexistent-file.rs",
    });

    expect(result.files).toHaveLength(0);
  }, 30_000);

  test("each file entry conforms to FileDiagnostics schema", async () => {
    const result = await collectRustDiagnostics({
      manifest: "tools/rust-mapper/Cargo.toml",
    });

    for (const file of result.files) {
      expect(file).toHaveProperty("uri");
      expect(file).toHaveProperty("path");
      expect(file).toHaveProperty("diagnostics");
      expect(file.uri).toMatch(/^file:\/\//);
      expect(typeof file.path).toBe("string");
      expect(Array.isArray(file.diagnostics)).toBe(true);

      for (const diag of file.diagnostics) {
        expect(diag).toHaveProperty("severity");
        expect(diag).toHaveProperty("line");
        expect(diag).toHaveProperty("column");
        expect(diag).toHaveProperty("message");
        expect(["error", "warning", "info", "hint"]).toContain(diag.severity);
        expect(typeof diag.line).toBe("number");
        expect(typeof diag.column).toBe("number");
        expect(diag.source).toBe("rustc");
      }
    }
  }, 30_000);
});
