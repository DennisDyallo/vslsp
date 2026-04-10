# Handoff — main

**Date:** 2026-04-10
**Branch:** main
**Last commit:** fe539c6 chore: update handoff for v1.7.3 — format parity, AX audit, session complete

---

## Session Summary

Two-day session (Apr 9–10). Goal: make vslsp fully AX-compliant — every tool, every format, every contract locked in CI. Starting from v1.5.3, shipped v1.6.0 and v1.7.0 through v1.7.3.

The arc: write the AX constitution → audit every tool against it → fix every gap → audit again → fix again → ship. Two background audit agents, one DevTeam Engineer+Reviewer loop, three parallel worktree agents for v1.6.0.

---

## Current State

### Committed Work (this session)

```
fe539c6 chore: update handoff for v1.7.3
08995e6 fix: AX format parity — single-file warning uses actual serialized size
e4050f5 fix: CodeAudit corrections to toTextFormat/toYamlFormat serializers
a5e9547 fix: depth and file_filter now apply to text and yaml formats
4285cbd feat: add --version flag; release v1.7.1
d725249 chore: update handoff for v1.7.0 release
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

None. Working tree clean.

### Build & Test Status

- TypeScript: **clean** (`bun run tsc --noEmit`)
- Unit: **49 pass, 0 fail** (http×16, types×10, store×8, mapper×6, typescript×5, rust×4)
- E2E: **35 pass, 1 skip, 0 fail** (skip = RustMapper not installed)
- Released: **v1.7.3** — tagged and pushed, CI triggered

### Worktree / Parallel Agent State

Two stale worktrees from this session's v1.6.0 parallel agents — both merged into main:

| Worktree | Branch | Last commit | Status |
|----------|--------|-------------|--------|
| `.claude/worktrees/agent-a53e50a8` | `worktree-agent-a53e50a8` | `e261cf3` docs: AX constitution | ✅ Merged — prune safe |
| `.claude/worktrees/agent-add47742` | `worktree-agent-add47742` | `d00a1ca` feat: uninstall-mapper | ✅ Merged — prune safe |

Prune: `git worktree prune`

---

## Readiness Assessment

**Target:** AI agents (Claude Code, Cursor, Windsurf) working on C#, Rust, or TypeScript codebases who need compilation diagnostics and code structure analysis via MCP — responses must never pollute the agent's context window.

| Need | Status | Notes |
|------|--------|-------|
| Get compilation errors scoped to what matters | ✅ Working | `severity:"error"` + `limit:20` → < 10KB. Warning fires when unfiltered > 50KB |
| Understand codebase structure without reading files | ✅ Working | `depth:"signatures"` default; AX truncation at 200KB across all 3 formats |
| Dry-run compile check before writing (C#) | ✅ Working | `verify_changes` with daemon; in-memory, disk never touched |
| Responses never exceed context window budget | ✅ Working | Multi-file: auto-truncated with agent-actionable warning. Single-file: warns using actual format size (v1.7.3) |
| Know when a response is too large and what to do | ✅ Working | Every warning follows AX standard: what happened + directive + example |
| Install / remove language mappers | ✅ Working | `vslsp install-mapper <lang>` + `vslsp uninstall-mapper <lang>` |
| Query any project, any directory | ✅ Working | All tools are stateless; `path`/`project`/`manifest`/`solution` per-call |
| AX contracts don't regress in CI | ✅ Working | 13 ratchet tests: A1-A6, A3b, A4b, B1-B5 (dual-bound: upper + lower) |
| Check installed version | ✅ Working | `vslsp --version` (v1.7.1+) |
| All output formats AX-equivalent | ✅ Working | JSON/text/yaml all filtered, all warn, warnings use actual format size (v1.7.3) |

**Overall:** ⭐ **Complete** — all stated AX goals met, all formats compliant, 13 ratchet tests in CI, three audit rounds converged to clean. v1.7.3 released.

**Critical next step:** No critical items. Upgrade installed binary once CI builds v1.7.3:
```bash
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --yes
vslsp --version  # → 1.7.3
```

---

## What's Next (Optional / Future)

1. **Go mapper** — Pattern established. Add `GoMapper` to registry, CI matrix, `install.sh`. Carried forward since v1.5.3.
2. **Rust/TypeScript daemon** — `verify_changes` dry-run is C#-only. Requires persistent `cargo check`/`tsc` processes.
3. **Multi-file AX truncation calibrated per format** — JSON size used as proxy for text/yaml (conservative, always safe). True per-format calibration would need restructuring.
4. **RustMapper 404 on patch releases** — Investigate `.github/workflows/release.yml` — CI may not build Rust mapper on every patch tag.
5. **Prune stale worktrees** — `git worktree prune`

---

## Blockers & Known Issues

- **RustMapper 404** — `vslsp install-mapper rust` fails with 404 on v1.7.x patches. Use v1.7.0 asset: `gh release download v1.7.0 --pattern "RustMapper-darwin-arm64" -D ~/.local/share/vslsp/rust-mapper/`
- **Installed binary is v1.7.0** — reinstall once v1.7.3 CI publishes.
- **1 E2E test skipped** — RustMapper not installed (see above).

**Intentional keeps:**
- Single-file oversize warns but doesn't truncate — `depth:"full"` is opt-in, agent can use `"signatures"` instead
- Multi-file truncation uses JSON as size proxy — always conservative (safe, never returns too much)
- `withDiagnosticsAxWarning` warns only for diagnostics — truncating diagnostic results would change semantics

---

## Key File References

| File | Purpose |
|------|---------|
| `docs/AX.md` | AX constitution — canonical philosophy |
| `mcp.ts:99,108` | `AX_BUDGET_BYTES` (200KB), `AX_DIAG_WARN_BYTES` (50KB) |
| `mcp.ts:110-188` | `filterCodeStructure()` — depth/glob/max_files + truncation |
| `mcp.ts:190-210` | `toTextFormat()` — JSON → text |
| `mcp.ts:212-256` | `toYamlFormat()` — JSON → YAML (always-quoted strings) |
| `mcp.ts:219-240` | `withDiagnosticsAxWarning()` — diagnostics 50KB threshold |
| `mcp.ts:285-295` | `enrichError()` — ENOENT/EACCES agent guidance |
| `mcp.ts:464` | `depth` default `"signatures"` |
| `mcp.ts:587-614` | Handler — format serialization + actual-size AX check |
| `tests/e2e/mcp-server.test.ts` | 13 AX ratchet tests |
| `tests/http.test.ts` | 16 HTTP behavior tests |
| `vslsp.ts` | CLI — `install-mapper`, `uninstall-mapper`, `--version` |

---

## Quick Start for New Agent

```bash
cd /Users/Dennis.Dyall/Code/other/vslsp

# Verify state
git log --oneline -5
git status
bun run tsc --noEmit
bun test tests/http.test.ts tests/diagnostics/store.test.ts tests/core/types.test.ts \
  tests/code-mapping/mapper.test.ts tests/diagnostics/rust.test.ts \
  tests/diagnostics/typescript.test.ts --timeout 30000
bun test tests/e2e/mcp-server.test.ts --timeout 120000

# v1.7.3 — AX-complete across JSON/text/yaml
# AX constitution: docs/AX.md
# 13 AX ratchet tests in CI

# Upgrade installed binary (once v1.7.3 CI builds):
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --yes
vslsp --version  # → 1.7.3

# Fix Rust mapper 404:
gh release download v1.7.0 --pattern "RustMapper-darwin-arm64" \
  --repo DennisDyallo/vslsp -D ~/.local/share/vslsp/rust-mapper/
chmod +x ~/.local/share/vslsp/rust-mapper/RustMapper

# Prune stale worktrees:
git worktree prune
```
