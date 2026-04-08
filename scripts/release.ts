#!/usr/bin/env bun
/**
 * Release and deploy script.
 *
 * Usage:
 *   bun run release <version>
 *   bun run release 1.2.0
 *
 * Steps:
 *   1. Validate semver version arg
 *   2. Pre-flight: branch, tag, dirty tree, remote sync, tsc, tests
 *   3. Bump package.json version (skipped if already at target)
 *   4. Commit, push main, tag, push tag → triggers CI release
 *   5. Rebuild and deploy local binaries (vslsp-mcp, vslsp)
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");

// ── Helpers ────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], opts: { cwd?: string; failMessage?: string } = {}): string {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    console.error(`\n✗ ${opts.failMessage ?? `${cmd} ${args.join(" ")} failed`}`);
    process.exit(1);
  }
  return result.stdout?.trim() ?? "";
}

function runPassthrough(cmd: string, args: string[], opts: { failMessage?: string } = {}): void {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    console.error(`\n✗ ${opts.failMessage ?? `${cmd} ${args.join(" ")} failed`}`);
    process.exit(1);
  }
}

function runQuiet(cmd: string, args: string[]): { stdout: string; status: number } {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── 1. Parse version arg ───────────────────────────────────────────────────

const version = process.argv[2];

if (!version || version === "--help" || version === "-h") {
  console.log(`
Usage:
  bun run release <version>

Examples:
  bun run release 1.2.0
  bun run release 2.0.0-rc.1

Steps performed:
  1. Validate semver version
  2. Pre-flight checks (branch, tag, dirty tree, remote sync, tsc, tests)
  3. Bump package.json version (skipped if already at target)
  4. Commit → push main → tag vX.Y.Z → push tag (triggers CI release)
  5. Build and deploy local binaries to ~/.local/share/vslsp/
`);
  process.exit(version ? 0 : 1);
}

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail(`Invalid version "${version}". Expected semver format: 1.2.3 or 1.2.3-rc.1`);
}

// ── 2. Pre-flight checks (all read-only — no mutations yet) ────────────────

console.log("→ Pre-flight checks...");

// Branch
const branch = runQuiet("git", ["branch", "--show-current"]).stdout;
if (branch !== "main") {
  fail(`Must release from main branch (currently: ${branch || "detached HEAD"}). Switch to main first.`);
}
console.log("  ✓ On main branch");

// Tag must not already exist
const existingTag = runQuiet("git", ["tag", "-l", `v${version}`]).stdout;
if (existingTag) {
  fail(`Tag v${version} already exists. Choose a different version or delete the tag first:\n    git tag -d v${version} && git push origin :refs/tags/v${version}`);
}
console.log(`  ✓ Tag v${version} is available`);

// Dirty tree (tracked files only)
const dirty = runQuiet("git", ["diff", "--stat", "HEAD"]).stdout;
if (dirty) {
  fail(`Working tree has uncommitted changes. Commit or stash them first:\n\n${dirty}`);
}
console.log("  ✓ Working tree clean");

// Remote sync — fetch then check if behind
console.log("  ↳ Fetching origin/main...");
const fetchResult = runQuiet("git", ["fetch", "origin", "main"]);
if (fetchResult.status !== 0) {
  console.warn("  ⚠ Could not reach origin — skipping remote sync check");
} else {
  const behind = runQuiet("git", ["rev-list", "HEAD..origin/main", "--count"]).stdout;
  if (parseInt(behind, 10) > 0) {
    fail(`Local main is ${behind} commit(s) behind origin/main. Run 'git pull' first.`);
  }
  console.log("  ✓ Local main is up to date with origin");
}

// TypeScript
console.log("\n→ Type-checking...");
runPassthrough("bun", ["run", "tsc", "--noEmit"], { failMessage: "TypeScript errors found. Fix them before releasing." });
console.log("  ✓ No TypeScript errors");

// Tests
console.log("\n→ Running test suite...");
runPassthrough("bun", ["test", "--timeout", "60000"], {
  failMessage: "Tests failed. Fix failures before releasing.",
});
console.log("  ✓ All tests pass");

// ── 3. Bump package.json (conditional) ────────────────────────────────────

console.log(`\n→ Bumping version to ${version}...`);
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8")) as { version: string; [k: string]: unknown };
const previous = pkg.version;

if (previous === version) {
  console.log(`  ✓ package.json already at ${version} — skipping bump commit`);
} else {
  pkg.version = version;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ✓ package.json: ${previous} → ${version}`);

  // ── 4a. Commit version bump ──────────────────────────────────────────────
  console.log("\n→ Committing version bump...");
  run("git", ["add", "package.json"]);
  run("git", ["commit", "-m", `chore: release v${version}`], {
    failMessage: "git commit failed",
  });
  console.log("  ✓ Committed");
}

// ── 4b. Push main ──────────────────────────────────────────────────────────

console.log("\n→ Pushing main...");
runPassthrough("git", ["push", "origin", "main"], { failMessage: "git push main failed" });
console.log("  ✓ Pushed main");

// ── 4c. Tag and push ───────────────────────────────────────────────────────

console.log(`\n→ Tagging v${version}...`);
run("git", ["tag", `v${version}`], { failMessage: `git tag v${version} failed` });
runPassthrough("git", ["push", "origin", `v${version}`], { failMessage: "git push tag failed" });
console.log(`  ✓ Tagged and pushed v${version} → CI release job triggered`);

// ── 5. Deploy local binaries ───────────────────────────────────────────────

const INSTALL_DIR = join(homedir(), ".local", "share", "vslsp");

console.log("\n→ Building and deploying local binaries...");

runPassthrough(
  "bun",
  ["build", "mcp.ts", "--compile", "--outfile", join(INSTALL_DIR, "vslsp-mcp")],
  { failMessage: "Failed to build vslsp-mcp" }
);
console.log("  ✓ vslsp-mcp deployed");

runPassthrough(
  "bun",
  ["build", "vslsp.ts", "--compile",
   "--define", `VSLSP_VERSION="${version}"`,
   "--outfile", join(INSTALL_DIR, "vslsp")],
  { failMessage: "Failed to build vslsp" }
);
console.log("  ✓ vslsp deployed");

// ── Done ───────────────────────────────────────────────────────────────────

console.log(`
✓ Released v${version}

  Local binaries: ${INSTALL_DIR}/
  CI release:     https://github.com/DennisDyallo/vslsp/releases/tag/v${version}

CI is building release binaries now. Check status:
  gh run list --repo DennisDyallo/vslsp --limit 5
`);
