# Handoff — main

**Date:** 2026-04-09
**Branch:** main
**Last commit:** 8a3676e chore: handoff — v1.5.1 complete, AX byte-budget verified end-to-end

---

## Session Summary

This session added the E2E test for AX byte-budget auto-truncation (the first optional item from the v1.5.1 handoff). While writing the test, we discovered that the AX truncation path was dead code for the default (no filters) case — `filterCodeStructure` was gated behind `needsFilter`, which was false when no explicit depth/file_filter/max_files was passed. Fixed by routing all JSON-format output through `filterCodeStructure`, ensuring AX budget enforcement always fires regardless of whether the user sets explicit filters.

---

## Current State

### Uncommitted Work (2 files modified)

```
M mcp.ts                       — 21 insertions/deletions: route all JSON output through filterCodeStructure for AX budget
M tests/e2e/mcp-server.test.ts — 76 insertions: A6 test generates 60-file synthetic fixture, verifies truncation
```

**mcp.ts change:** Replaced `if (needsFilter)` with `if (effectiveFormat === "json")` in the `get_code_structure` handler. Removed the redundant auto-detection warning code (already handled by `buildResult` inside `filterCodeStructure`). Net -17 lines, +4 lines.

**test change:** Added test A6 to the "output filtering — AX context window contract" describe block. Generates 60 TypeScript files (5 classes, 8 methods each = ~1.4MB raw AST), calls `get_code_structure` with no filters, asserts: response ≤ 210KB, warning field present with "truncated" and original file count, returned files < 60, summary counts recomputed correctly via manual walk. Fixture cleaned up in `try/finally`.

### Committed Work (this session — 0 new commits)

No commits yet. Previous session's last commit: 8a3676e.

### Build & Test Status

- TypeScript type check: **clean** (`bun run tsc --noEmit`)
- Tests: **32 pass, 1 skip, 0 fail** (`bun test` — 1 new test A6 since v1.5.1)
- All existing A1-A5 and B1-B4 AX contract tests still pass

### Worktree / Parallel Agent State

None. Single worktree at main.

---

## Readiness Assessment

**Target:** AI agents (Claude Code, Cursor, Windsurf) working on C#, Rust, or TypeScript codebases who need compilation diagnostics and code structure analysis via MCP — responses must never pollute the agent's context window.

| Need | Status | Notes |
|------|--------|-------|
| Get all compilation errors at once | ✅ Working | Unified `get_diagnostics` across C#/Rust/TS. `severity`+`limit` filters |
| Understand codebase structure without reading files | ✅ Working | `get_code_structure` with `depth`/`file_filter`/`max_files` |
| Dry-run compile check before writing (C#) | ✅ Working | `verify_changes` with daemon. `reverted: true` confirmed |
| Responses stay within context window budget | ✅ Working | AX auto-truncation at 200KB — **now fires for all JSON output**, not just filtered |
| No context bombs on large codebases | ✅ Working | Rust 2.9MB→181KB, C# 663KB→200KB. Synthetic 1.4MB→≤210KB |
| Warning when response is truncated | ✅ Working | `warning` field with file counts and scope suggestions |
| Explicit `max_files` overrides auto-cap | ✅ Working | Auto-cap gated on `opts.max_files === undefined` |
| Diagnostics filters (severity + limit) | ✅ Working | 633 C# errors → 20 errors in ~5KB response |
| Summary counts match returned data | ✅ Working | Namespace/type/method counts recomputed after truncation |
| AX contracts enforced in CI | ✅ Working | 10 ratchet tests: A1-A6, B1-B4. A6 explicitly triggers truncation |

**Overall:** ⭐ Complete — all AX goals met, truncation path now verified end-to-end with dedicated E2E test, all 10 contract tests pass.

**Critical next step:** Commit the current changes and release as v1.5.2 (bug fix: AX truncation was inactive for unfiltered requests).

---

## What's Next (Prioritized)

### Ready to commit

1. **Commit + release v1.5.2** — Bug fix: AX truncation now fires for all JSON output (was dead code for default unfiltered path). New test A6.

### Optional / Future

2. **Go mapper** — Pattern established. Add `GoMapper` to registry, CI matrix, `install.sh`.

3. **`vslsp uninstall-mapper`** — No removal path currently exists.

4. **Update plan doc status** — `Plans/federated-coalescing-lampson.md` status header should be updated to reflect current state.

5. **Rust/TS daemon** — `verify_changes` dry-run currently C#-only. Would require persistent `cargo check`/`tsc` processes.

---

## Blockers & Known Issues

None. The truncation bug discovered this session is already fixed in the uncommitted changes.

**Note on AX budget precision:** The binary search converges to the largest file count that fits, but JSON serialization variance can cause minor overages (~0.07%). The test uses a 210KB tolerance (vs 200KB budget) to account for this.

---

## Key File References

| File | Purpose |
|------|---------|
| `mcp.ts:442` | Changed `if (needsFilter)` → `if (effectiveFormat === "json")` — AX budget now enforced for all JSON output |
| `mcp.ts:89-93` | `AX_BUDGET_BYTES = 200_000` constant |
| `mcp.ts:96-165` | `filterCodeStructure()` — depth/glob/max_files/AX truncation pipeline |
| `tests/e2e/mcp-server.test.ts` | 33 E2E tests including 10 AX contract tests (A1-A6, B1-B4) |
| `CLAUDE.md` | Agent quick-start — 8 tools, AX-safe filter guidance |

---

## Quick Start for New Agent

```bash
cd /Users/Dennis.Dyall/Code/other/vslsp

# Verify state
git log --oneline -5
git status
bun run tsc --noEmit          # clean
bun test --timeout 60000      # 32 pass, 1 skip, 0 fail

# The uncommitted changes fix a bug where AX truncation didn't fire
# for unfiltered get_code_structure calls. Ready to commit + release.

# Commit and release
git add mcp.ts tests/e2e/mcp-server.test.ts
git commit -m "fix: AX truncation fires for all JSON output, add E2E test A6"
bun run release 1.5.2

# Integration test (validates all 8 tools against 3 real codebases)
# invoke /vslsp-integration skill
```
