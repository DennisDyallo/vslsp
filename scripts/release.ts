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
 *   2. Check git working tree has no uncommitted tracked changes
 *   3. Run test suite — abort on failure
 *   4. Bump package.json version
 *   5. Commit, push main, tag, push tag → triggers CI release
 *   6. Rebuild and deploy local binaries (vslsp-mcp, vslsp)
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
  2. Check no uncommitted tracked changes (untracked files OK)
  3. Run test suite
  4. Bump package.json version
  5. Commit → push main → tag vX.Y.Z → push tag (triggers CI release)
  6. Build and deploy local binaries to ~/.local/share/vslsp/
`);
  process.exit(version ? 0 : 1);
}

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail(`Invalid version "${version}". Expected semver format: 1.2.3 or 1.2.3-rc.1`);
}

// ── 2. Git dirty check (tracked files only) ────────────────────────────────

console.log("→ Checking git working tree...");
const dirty = run("git", ["diff", "--stat", "HEAD"]);
if (dirty) {
  fail(
    `Working tree has uncommitted changes. Commit or stash them first:\n\n${dirty}`
  );
}
console.log("  ✓ Working tree clean");

// ── 3. Test suite ──────────────────────────────────────────────────────────

console.log("\n→ Running test suite...");
runPassthrough("bun", ["test", "--timeout", "60000"], {
  failMessage: "Tests failed. Fix failures before releasing.",
});
console.log("  ✓ All tests pass");

// ── 4. Bump package.json ───────────────────────────────────────────────────

console.log(`\n→ Bumping version to ${version}...`);
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8")) as { version: string; [k: string]: unknown };
const previous = pkg.version;
pkg.version = version;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
console.log(`  ✓ package.json: ${previous} → ${version}`);

// ── 5. Commit, push, tag ───────────────────────────────────────────────────

console.log("\n→ Committing version bump...");
run("git", ["add", "package.json"]);
run("git", ["commit", "-m", `chore: release v${version}`], {
  failMessage: "git commit failed",
});
console.log("  ✓ Committed");

console.log("\n→ Pushing main...");
runPassthrough("git", ["push", "origin", "main"], { failMessage: "git push main failed" });
console.log("  ✓ Pushed main");

console.log(`\n→ Tagging v${version}...`);
run("git", ["tag", `v${version}`], { failMessage: `git tag v${version} failed — tag may already exist` });
runPassthrough("git", ["push", "origin", `v${version}`], { failMessage: "git push tag failed" });
console.log(`  ✓ Tagged and pushed v${version} → CI release job triggered`);

// ── 6. Deploy local binaries ───────────────────────────────────────────────

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
  ["build", "vslsp.ts", "--compile", "--outfile", join(INSTALL_DIR, "vslsp")],
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
