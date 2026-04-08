import { describe, test, expect } from "bun:test";
import { map } from "../../src/code-mapping/mapper";
import { existsSync } from "fs";
import { DEFAULT_TS_MAPPER } from "../../src/core/defaults";

describe("mapper — real code structure analysis", () => {
  test("maps a real TypeScript file and extracts interfaces, functions, types", async () => {
    if (!existsSync(DEFAULT_TS_MAPPER)) {
      console.warn("TSMapper binary not installed, skipping");
      return;
    }

    // Map the project's own types.ts — has interfaces, functions, type exports
    const result = await map({
      path: "src/core/types.ts",
      format: "json",
      language: "typescript",
    });

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.output);
    expect(parsed.files.length).toBeGreaterThan(0);

    const file = parsed.files[0];
    const memberTypes = file.members.map((m: any) => m.type);

    // types.ts defines interfaces and exported functions — verify they're found
    expect(memberTypes).toContain("Interface"); // DiagnosticEntry, FileDiagnostics, etc.
    expect(memberTypes).toContain("Fn"); // severityToString, diagnosticToEntry, matchFilePath

    // Verify CodeMember schema on every member recursively
    function verifyMember(member: any) {
      expect(typeof member.type).toBe("string");
      expect(typeof member.signature).toBe("string");
      expect(typeof member.lineNumber).toBe("number");
      expect(member.lineNumber).toBeGreaterThan(0);
      expect(typeof member.isStatic).toBe("boolean");
      expect(typeof member.visibility).toBe("string");
      expect(typeof member.docString).toBe("string");
      expect(Array.isArray(member.baseTypes)).toBe(true);
      expect(Array.isArray(member.attributes)).toBe(true);
      expect(Array.isArray(member.children)).toBe(true);

      for (const child of member.children) {
        verifyMember(child);
      }
    }

    for (const member of file.members) {
      verifyMember(member);
    }
  }, 15_000);

  test("throws descriptive error when mapper binary not found", async () => {
    await expect(
      map({ path: "src/core/types.ts", codeMapperPath: "/nonexistent/binary" })
    ).rejects.toThrow("not found");
  });

  test("throws descriptive error when target path doesn't exist", async () => {
    await expect(
      map({ path: "/this/path/does/not/exist.ts", language: "typescript" })
    ).rejects.toThrow("not found");
  });

  test("auto-detects language from file extension", async () => {
    if (!existsSync(DEFAULT_TS_MAPPER)) {
      console.warn("TSMapper binary not installed, skipping");
      return;
    }

    // Don't pass language — should auto-detect .ts as typescript
    const result = await map({
      path: "src/core/types.ts",
      format: "json",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.files.length).toBeGreaterThan(0);
  }, 15_000);

  test("auto-detects TypeScript from a directory containing .ts files", async () => {
    if (!existsSync(DEFAULT_TS_MAPPER)) {
      console.warn("TSMapper binary not installed, skipping");
      return;
    }

    // src/core/ contains .ts files — language should be detected from directory scan
    const result = await map({
      path: "src/core",
      format: "json",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.files.length).toBeGreaterThan(0);
  }, 15_000);
});
