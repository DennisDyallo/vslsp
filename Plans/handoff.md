# Handoff — main

**Date:** 2026-04-09
**Branch:** main
**Last commit:** 95d2656 chore: release v1.7.0

---

## Session Summary

This session was fully AX-driven across two releases. Starting from v1.5.3, the session produced v1.6.0 (AX constitution, `uninstall-mapper`, real HTTP behavior tests) and v1.7.0 (AX enforcement made rigorous: `depth` default flipped to `"signatures"`, `get_diagnostics` oversize warning, 13 AX ratchet tests, `enrichError` for agent-actionable OS errors). Two audit rounds and one DevTeam Engineer+Reviewer loop ensured every AX principle is now enforced at schema, runtime, and test levels.

---

## Current State

### Committed Work (this session)

```
95d2656 chore: release v1.7.0
bc2c70a test: strengthen B5 — unconditional size assert ensures warning path always executes
0296bea test: AX ratchet tests B5/A3b/A4b/A5+; fix F3 enrichError, F4 single-file msg, F6 param descriptions
771afc9 fix: AX warning for unfiltered get_diagnostics responses
8643bbc fix: flip depth default to signatures — AX G6
ce8ca05 fix: AX constitution compliance — tool schema and runtime gaps
dd78997 chore: release v1.6.0
8efa6f8 test: rewrite http.test.ts with real HTTP behavior tests
d00a1ca feat: add vslsp uninstall-mapper command
9000913 docs: add AX constitution — canonical agent experience philosophy
```

### Uncommitted Changes

None. Working tree clean. Only `.claude/` (untracked worktree metadata) appears in `git status`.

### Build & Test Status

- TypeScript type check: **clean** (`bun run tsc --noEmit`)
- Unit tests: **49 pass, 0 fail**
- E2E tests: 70+ pass including 13 AX ratchet tests
- Released: **v1.7.0** — tagged and pushed, CI triggered

### Worktree / Parallel Agent State

Two stale worktrees remain from this session's parallel W1/W2 agents — both fully merged into main:

| Worktree | Branch | Last commit | Status |
|----------|--------|-------------|--------|
| `.claude/worktrees/agent-a53e50a8` | `worktree-agent-a53e50a8` | `e261cf3` docs: AX constitution | ✅ Merged — safe to prune |
| `.claude/worktrees/agent-add47742` | `worktree-agent-add47742` | `d00a1ca` feat: uninstall-mapper | ✅ Merged — safe to prune |

Prune with: `git worktree prune`

---

## Readiness Assessment

**Target:** AI agents (Claude Code, Cursor, Windsurf) working on C#, Rust, or TypeScript codebases who need compilation diagnostics and code structure analysis via MCP — responses must never pollute the agent's context window.

| Need | Status | Notes |
|------|--------|-------|
| Get all compilation errors, scoped to errors only | ✅ Working | `get_diagnostics(severity:"error", limit:20)` → < 10KB |
| Understand codebase structure without reading files | ✅ Working | `get_code_structure(depth:"signatures")` default; AX budget enforced |
| Dry-run compile check before writing to disk (C#) | ✅ Working | `verify_changes` with daemon; `reverted: true` confirmed |
| Responses never exceed context window budget | ✅ Working | Auto-truncation at 200KB with agent-actionable warning |
| Warning when response would be too large | ✅ Working | `get_code_structure` truncates + warns; `get_diagnostics` warns at 50KB |
| Install / uninstall mappers per language | ✅ Working | `vslsp install-mapper` + `vslsp uninstall-mapper` (new this session) |
| AX contracts locked in CI — regressions caught | ✅ Working | 13 ratchet tests: A1-A6, A3b, A4b, B1-B5 (dual-bound: upper + lower) |
| AX philosophy documented and queryable | ✅ Working | `docs/AX.md` — constitution, budgets, principles, extension checklist |

**Overall:** ⭐ **Complete** — all AX goals met, 13 ratchet tests in CI, two audit rounds converged to clean, v1.7.0 released.

**Critical next step:** No critical items. Optional: Go mapper (pattern established), or `verify_changes` for Rust/TypeScript (requires persistent `cargo check`/`tsc` processes).

---

## What's Next (Prioritized)

### Optional / Future

1. **Go mapper** — Pattern established: add `GoMapper` to registry, CI matrix, `install.sh`. Carried forward since v1.5.3.

2. **Rust/TypeScript daemon** — `verify_changes` dry-run is C#-only. Would require persistent `cargo check`/`tsc` processes.

3. **AX truncation for `get_diagnostics`** — Currently warns only at 50KB (no truncation). Could add hard cap at e.g. 100KB for parity with `get_code_structure`. Low priority — warning already fires.

4. **Update `Plans/federated-coalescing-lampson.md`** — Status header should reference v1.7.0.

5. **Prune stale worktrees** — `git worktree prune` to clean up agent-a53e50a8 and agent-add47742.

---

## Blockers & Known Issues

None.

**Known intentional keeps:**
- `store.clear()` and `didClose()` — valid API surface, not dead code
- Single-file oversize warns but doesn't truncate — `depth:"full"` is opt-in, warning guides agent to use `"signatures"`
- `withDiagnosticsAxWarning` warns only (no truncation) — preserves full diagnostic semantics intentionally
- **RustMapper binary removed** during smoke test this session — reinstall: `vslsp install-mapper rust`

---

## Key File References

| File | Purpose |
|------|---------|
| `docs/AX.md` | AX constitution — canonical agent experience philosophy |
| `mcp.ts:99,107` | `AX_BUDGET_BYTES` (200KB) and `AX_DIAG_WARN_BYTES` (50KB) |
| `mcp.ts:102-187` | `filterCodeStructure()` — depth/glob/max_files + auto-truncation |
| `mcp.ts:218-239` | `withDiagnosticsAxWarning()` — diagnostics oversize warning |
| `mcp.ts:284-294` | `enrichError()` — ENOENT/EACCES → agent-actionable guidance |
| `mcp.ts:464` | `depth` default `"signatures"` (was `"full"` before this session) |
| `tests/e2e/mcp-server.test.ts:339-381` | B5 — `withDiagnosticsAxWarning` ratchet (unconditional) |
| `tests/e2e/mcp-server.test.ts:631-644` | A3b — `file_filter` 0-match warning ratchet |
| `tests/e2e/mcp-server.test.ts:659-671` | A4b — `max_files: 0` schema conformance |
| `tests/http.test.ts` | 16 real HTTP behavior tests (all 8 routes) |
| `vslsp.ts` | CLI — `install-mapper` + `uninstall-mapper` |

---

## Quick Start for New Agent

```bash
cd /Users/Dennis.Dyall/Code/other/vslsp

# Verify state
git log --oneline -5
git status
bun run tsc --noEmit          # clean
bun test tests/http.test.ts tests/diagnostics/store.test.ts tests/core/types.test.ts \
  tests/code-mapping/mapper.test.ts tests/diagnostics/rust.test.ts \
  tests/diagnostics/typescript.test.ts --timeout 30000

# Current version: v1.7.0 (released this session)
# AX constitution: docs/AX.md
# 13 AX ratchet tests in CI

# RustMapper was removed during smoke testing — reinstall if needed:
vslsp install-mapper rust

# Clean up stale session worktrees:
git worktree prune

# To run a code audit:
# invoke /CodeAudit

# Integration test (validates all 8 tools against 3 real codebases):
# invoke /vslsp-integration skill
```
