# Handoff — main

**Date:** 2026-04-10
**Branch:** main
**Last commit:** 65a9cbf fix: install-mapper URL missing v-prefix in version tag

---

## Session Summary

Two-day session (Apr 9–10). Full AX overhaul from v1.5.3 → v1.7.5 across eight releases. The session built the AX constitution, audited every tool against it twice, fixed every gap, and closed two latent install bugs discovered during live upgrade testing.

**Release arc:**
- **v1.6.0** — AX constitution (`docs/AX.md`), `uninstall-mapper`, HTTP behavior tests
- **v1.7.0** — `depth` default flipped to `"signatures"`, `withDiagnosticsAxWarning`, `enrichError`, 13 AX ratchet tests
- **v1.7.1** — `vslsp --version` flag
- **v1.7.2** — `toTextFormat`/`toYamlFormat`; depth/filters apply to all formats
- **v1.7.3** — AX format parity: single-file warning uses actual serialized size per format
- **v1.7.4** — macOS 15 Sequoia signing fix: `macos_sign()` in `install.sh`
- **v1.7.5** — `install-mapper` URL v-prefix fix (was `1.7.4`, needed `v1.7.4`)

---

## Current State

### Committed Work (this session, since v1.5.3)

```
65a9cbf fix: install-mapper URL missing v-prefix in version tag
8fd7a05 fix: auto-sign binaries on macOS 15 Sequoia — no more Killed: 9
b61243b chore: final handoff — v1.7.3 complete, FPA ⭐
08995e6 fix: AX format parity — single-file warning uses actual serialized size
e4050f5 fix: CodeAudit corrections to toTextFormat/toYamlFormat serializers
a5e9547 fix: depth and file_filter now apply to text and yaml formats
4285cbd feat: add --version flag; release v1.7.1
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
- Unit: **49 pass, 0 fail**
- E2E: **35 pass, 1 skip, 0 fail** — skip cleared by reinstalling Rust mapper
- Released and installed: **v1.7.5** (`vslsp --version` → `1.7.5`)
- All mappers installed: csharp ✅ typescript ✅ rust ✅

### Worktree / Parallel Agent State

| Worktree | Branch | Last commit | Status |
|----------|--------|-------------|--------|
| `.claude/worktrees/agent-a53e50a8` | `worktree-agent-a53e50a8` | `e261cf3` | ✅ Merged — prune safe |
| `.claude/worktrees/agent-add47742` | `worktree-agent-add47742` | `d00a1ca` | ✅ Merged — prune safe |

Prune: `git worktree prune`

---

## Readiness Assessment

**Target:** AI agents (Claude Code, Cursor, Windsurf) working on C#, Rust, or TypeScript codebases who need compilation diagnostics and code structure analysis via MCP — responses must never pollute the agent's context window.

| Need | Status | Notes |
|------|--------|-------|
| Get compilation errors scoped to what matters | ✅ Working | `severity:"error"` + `limit:20` → < 10KB; warns when unfiltered > 50KB |
| Understand codebase structure without reading files | ✅ Working | `depth:"signatures"` default; AX truncation at 200KB across all formats |
| Dry-run compile before writing (C#) | ✅ Working | `verify_changes` with daemon; disk never touched |
| Responses stay within context window budget | ✅ Working | Multi-file: auto-truncated + warned. Single-file: warned using actual format size |
| Know when too large and what to do | ✅ Working | All warnings: what happened + directive + concrete example (AX standard) |
| Install / uninstall mappers | ✅ Working | `vslsp install-mapper <lang>` + `vslsp uninstall-mapper <lang>` |
| Query any project, any directory | ✅ Working | Stateless — `path`/`project`/`manifest`/`solution` per call |
| AX contracts locked in CI | ✅ Working | 13 ratchet tests: A1-A6, A3b, A4b, B1-B5 (dual-bound) |
| Version self-reporting | ✅ Working | `vslsp --version` → `1.7.5` |
| Fresh install on macOS 15 — no manual steps | ✅ Working | `macos_sign()` strips stale Bun signature, re-signs ad-hoc |

**Overall:** ⭐ **Complete** — all stated AX goals met, install works cleanly on macOS 15, all mappers functional, 13 CI ratchets. v1.7.5 released and installed.

**Critical next step:** None. Optional: Go mapper, Rust/TS daemon, or `git worktree prune`.

---

## What's Next (Optional / Future)

1. **Go mapper** — Pattern established. `GoMapper` + registry + CI matrix + `install.sh`. Carried forward since v1.5.3.
2. **Rust/TypeScript daemon** — `verify_changes` dry-run is C#-only. Requires persistent `cargo check`/`tsc` processes.
3. **Multi-file AX truncation calibrated per format** — JSON size used as proxy for text/yaml (conservative, always safe). True per-format calibration would require restructuring.
4. **Prune stale worktrees** — `git worktree prune`

---

## Blockers & Known Issues

None.

**Intentional keeps:**
- Single-file oversize warns but doesn't truncate — `depth:"full"` is opt-in, agent can use `"signatures"` instead
- Multi-file truncation uses JSON as size proxy — always conservative (safe, never returns too much)
- `withDiagnosticsAxWarning` warns only — preserves full diagnostic semantics

---

## Key File References

| File | Purpose |
|------|---------|
| `docs/AX.md` | AX constitution — canonical philosophy |
| `install.sh:23-31` | `macos_sign()` — strips + re-signs on macOS 15 |
| `vslsp.ts:237-241` | `install-mapper` URL construction with v-prefix fix |
| `mcp.ts:99,108` | `AX_BUDGET_BYTES` (200KB), `AX_DIAG_WARN_BYTES` (50KB) |
| `mcp.ts:110-188` | `filterCodeStructure()` — all filtering + AX truncation |
| `mcp.ts:190-210` | `toTextFormat()` — JSON → text |
| `mcp.ts:212-256` | `toYamlFormat()` — JSON → YAML (always-quoted strings) |
| `mcp.ts:219-240` | `withDiagnosticsAxWarning()` — diagnostics 50KB warning |
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

# Verify
git log --oneline -5
git status
bun run tsc --noEmit
bun test tests/http.test.ts tests/diagnostics/store.test.ts tests/core/types.test.ts \
  tests/code-mapping/mapper.test.ts tests/diagnostics/rust.test.ts \
  tests/diagnostics/typescript.test.ts --timeout 30000
bun test tests/e2e/mcp-server.test.ts --timeout 120000

# v1.7.5 — fully operational
vslsp --version                    # → 1.7.5
vslsp install-mapper rust          # works — v-prefix fixed
vslsp install-mapper typescript    # works

# Install from scratch (macOS 15 compatible):
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --yes
# No Killed: 9. No manual signing. Works on macOS 13/14/15.

# Clean up stale session worktrees:
git worktree prune
```
