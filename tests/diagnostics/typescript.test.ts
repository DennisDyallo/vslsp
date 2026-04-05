import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { collectTsDiagnostics } from "../../src/diagnostics/typescript";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";

const FIXTURE_DIR = resolve(import.meta.dir, "../fixtures/ts-project");

describe("collectTsDiagnostics — real TypeScript projects", () => {
  beforeAll(() => {
    // Create a minimal TS project with intentional errors
    mkdirSync(join(FIXTURE_DIR, "src"), { recursive: true });

    writeFileSync(join(FIXTURE_DIR, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
      },
      include: ["src"],
    }));

    // File with a real type error
    writeFileSync(join(FIXTURE_DIR, "src/broken.ts"), `
const x: number = "not a number";
function greet(name: string): number {
  return name; // wrong return type
}
`);

    // File that is correct
    writeFileSync(join(FIXTURE_DIR, "src/clean.ts"), `
export function add(a: number, b: number): number {
  return a + b;
}
`);
  });

  afterAll(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  test("throws when tsconfig.json not found", async () => {
    await expect(
      collectTsDiagnostics({ project: "/nonexistent/path" })
    ).rejects.toThrow("tsconfig.json not found");
  });

  test("detects real type errors in broken TypeScript files", async () => {
    const result = await collectTsDiagnostics({ project: FIXTURE_DIR });

    expect(result.clean).toBe(false);
    expect(result.summary.errors).toBeGreaterThanOrEqual(2);

    // Should find errors in broken.ts
    const brokenFile = result.files.find(f => f.path.includes("broken.ts"));
    expect(brokenFile).toBeDefined();
    expect(brokenFile!.diagnostics.length).toBeGreaterThanOrEqual(2);

    // Verify diagnostics have proper structure
    for (const diag of brokenFile!.diagnostics) {
      expect(diag.severity).toBe("error");
      expect(diag.code).toMatch(/^TS\d+$/);
      expect(diag.source).toBe("tsc");
      expect(diag.line).toBeGreaterThan(0);
      expect(diag.column).toBeGreaterThan(0);
    }

    // clean.ts should NOT appear (no errors)
    const cleanFile = result.files.find(f => f.path.includes("clean.ts"));
    expect(cleanFile).toBeUndefined();
  }, 30_000);

  test("file filter returns only matching file diagnostics", async () => {
    const result = await collectTsDiagnostics({
      project: FIXTURE_DIR,
      file: "broken.ts",
    });

    // Should only contain broken.ts
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.path).toContain("broken.ts");
    expect(result.summary.errors).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("file filter with nonexistent file returns empty results", async () => {
    const result = await collectTsDiagnostics({
      project: FIXTURE_DIR,
      file: "does-not-exist.ts",
    });

    expect(result.files).toHaveLength(0);
    expect(result.summary.errors).toBe(0);
    expect(result.clean).toBe(true);
  }, 30_000);

  test("clean project returns no diagnostics", async () => {
    // Create a separate clean project
    const cleanDir = resolve(import.meta.dir, "../fixtures/ts-clean");
    mkdirSync(join(cleanDir, "src"), { recursive: true });

    writeFileSync(join(cleanDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ES2022", moduleResolution: "bundler" },
      include: ["src"],
    }));
    writeFileSync(join(cleanDir, "src/index.ts"), `export const PI: number = 3.14;\n`);

    try {
      const result = await collectTsDiagnostics({ project: cleanDir });

      expect(result.clean).toBe(true);
      expect(result.summary.errors).toBe(0);
      expect(result.files).toHaveLength(0);
      expect(result.solution).toContain("tsconfig.json");
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  }, 30_000);
});
