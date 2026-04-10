# Handoff — main

**Date:** 2026-04-10
**Branch:** main
**Last commit:** 08995e6 fix: AX format parity — single-file warning uses actual serialized size

---

## Session Summary

Two-day session (Apr 9–10) fully AX-driven across four releases. Starting from v1.5.3, the session produced v1.6.0 and v1.7.x (v1.7.0 through v1.7.3). The arc: build the AX constitution → audit against it → fix every gap found → ship.

**v1.6.0** (parallel worktree agents):
- `docs/AX.md` — AX constitution (goal, budgets, 5 principles, tool schema standards, error message standard, CI enforcement, extension checklist)
- `vslsp uninstall-mapper <lang>` — CLI install/uninstall symmetry
- `tests/http.test.ts` rewrite — 4 brittle string matches → 16 real HTTP behavior tests

**v1.7.0** (AX audit round 1 + round 2 + DevTeam fix loop):
- `depth` default flipped `"full"` → `"signatures"` (AX-safe default)
- `withDiagnosticsAxWarning()` — warns when `get_diagnostics` unfiltered > 50KB
- `enrichError()` — ENOENT/EACCES → agent-actionable guidance in all tools
- 13 AX ratchet tests (A1-A6, A3b, A4b, B1-B5, A5+) locked in CI
- All tool schema descriptions updated with budget numbers and AX implications
- `file_filter` 0-match runtime warning added

**v1.7.1** — `vslsp --version` flag (CLI DX gap closed)

**v1.7.2** — `toTextFormat()` + `toYamlFormat()` client-side serializers; `depth`/`file_filter`/`max_files` now apply to text and yaml formats (previously forced JSON)

**CodeAudit fixes** (between v1.7.2 and v1.7.3):
- `yamlStr()` always quotes (matches mapper binary output)
- `walkText()` hoisted out of loop (anti-pattern fix)
- `format` param description updated (no longer claims "ignored when filters set")

**v1.7.3** — AX format parity: single-file oversized warning now uses actual serialized size for text/yaml, not JSON proxy (no false-positive warnings for text/yaml that fit the budget)

---

## Current State

### Committed Work (since v1.5.3)

```
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
- Unit tests: **49 pass, 0 fail** (http ×16, types ×10, store ×8, mapper ×6, typescript ×5, rust ×4)
- E2E tests: **35 pass, 1 skip, 0 fail** (skip = RustMapper not installed)
- Installed version: **v1.7.0** (upgrade with `install.sh --yes` once v1.7.3 CI builds)

### Format Output Reference

All three formats use the same `src/core/types.ts` source, `depth:"signatures"`:

**JSON** — machine-parseable, all fields present, AX-filtered. ~8KB for this file at signatures depth.

**Text** — `[Type] signature :lineNumber // docstring`. Lowest token cost. Good for quick scan.

**YAML** — signatures always double-quoted (safe for `:` and `"` in type signatures). Medium token cost. Readable with nesting.

### Worktree State

Two stale worktrees from v1.6.0 parallel agents — both merged. Prune with: `git worktree prune`

---

## Readiness Assessment

**Target:** AI agents (Claude Code, Cursor, Windsurf) working on C#, Rust, or TypeScript codebases who need compilation diagnostics and code structure analysis via MCP — responses must never pollute the agent's context window.

| Need | Status | Notes |
|------|--------|-------|
| Get all compilation errors, scoped | ✅ Working | `get_diagnostics(severity:"error", limit:20)` → < 10KB |
| Understand codebase structure without reading files | ✅ Working | `get_code_structure(depth:"signatures")` default; AX budget enforced |
| Dry-run compile check before writing (C#) | ✅ Working | `verify_changes` with daemon; `reverted: true` |
| Responses never exceed context window budget | ✅ Working | Auto-truncation at 200KB + warnings in all formats |
| Warning when response would be too large | ✅ Working | `get_code_structure` truncates + warns; `get_diagnostics` warns at 50KB |
| Install / uninstall mappers | ✅ Working | `vslsp install-mapper` + `vslsp uninstall-mapper` |
| AX contracts locked in CI | ✅ Working | 13 ratchet tests (A1-A6, A3b, A4b, B1-B5) |
| AX philosophy documented | ✅ Working | `docs/AX.md` constitution |
| All output formats AX-equivalent | ✅ Working | JSON/text/yaml all filtered, all warn, all AX-safe (v1.7.3) |
| Version self-reporting | ✅ Working | `vslsp --version` (v1.7.1+) |

**Overall:** ⭐ **Complete** — all AX goals met across all formats, 13 ratchet tests in CI, three audit rounds converged to clean, v1.7.3 released.

**Critical next step:** No critical items. Install v1.7.3 once CI builds: `curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --yes`

---

## What's Next (Optional / Future)

1. **Go mapper** — Pattern established. `GoMapper` + registry + CI matrix + `install.sh`. Carried forward since v1.5.3.
2. **Rust/TypeScript daemon** — `verify_changes` dry-run is C#-only. Requires persistent `cargo check`/`tsc` processes.
3. **Multi-file AX truncation calibrated per format** — Currently uses JSON size as proxy (conservative, always safe). Could be calibrated to actual format size for fewer unnecessary truncations.
4. **`vslsp install-mapper rust` 404 investigation** — CI may not be cross-compiling Rust mapper for patch releases. Check `.github/workflows/release.yml` build matrix.
5. **Prune stale worktrees** — `git worktree prune`

---

## Blockers & Known Issues

- **RustMapper 404** — `vslsp install-mapper rust` fails with 404 on v1.7.x patch releases. Likely CI doesn't build Rust mapper on every patch. Workaround: use v1.7.0 binary for Rust mapper, or check release assets.
- **Installed binary is v1.7.0** — upgrade with `install.sh --yes` once v1.7.3 CI releases.
- **1 E2E test skipped** — RustMapper not installed. `vslsp install-mapper rust` to fix (once 404 resolved).

**Intentional keeps:**
- Single-file oversize warns but doesn't truncate — `depth:"full"` is opt-in
- Multi-file AX truncation uses JSON size as proxy — conservative but always safe
- `withDiagnosticsAxWarning` warns only (no truncation) — preserves full diagnostic semantics

---

## Key File References

| File | Purpose |
|------|---------|
| `docs/AX.md` | AX constitution |
| `mcp.ts:99,108` | `AX_BUDGET_BYTES` (200KB), `AX_DIAG_WARN_BYTES` (50KB) |
| `mcp.ts:110-188` | `filterCodeStructure()` — all filtering + AX truncation |
| `mcp.ts:190-210` | `toTextFormat()` — JSON → text serializer |
| `mcp.ts:212-256` | `toYamlFormat()` — JSON → YAML serializer (always-quoted strings) |
| `mcp.ts:219-240` | `withDiagnosticsAxWarning()` — diagnostics oversize warning |
| `mcp.ts:285-295` | `enrichError()` — ENOENT/EACCES → agent-actionable guidance |
| `mcp.ts:464` | `depth` default `"signatures"` |
| `mcp.ts:587-614` | Handler — serialize to format, single-file AX check on actual size |
| `tests/e2e/mcp-server.test.ts` | 13 AX ratchet tests (A1-A6, A3b, A4b, B1-B5) |
| `tests/http.test.ts` | 16 real HTTP behavior tests |
| `vslsp.ts` | CLI — `install-mapper`, `uninstall-mapper`, `--version` |

---

## Quick Start for New Agent

```bash
cd /Users/Dennis.Dyall/Code/other/vslsp

git log --oneline -5
git status
bun run tsc --noEmit
bun test tests/http.test.ts tests/diagnostics/store.test.ts tests/core/types.test.ts \
  tests/code-mapping/mapper.test.ts tests/diagnostics/rust.test.ts \
  tests/diagnostics/typescript.test.ts --timeout 30000
bun test tests/e2e/mcp-server.test.ts --timeout 120000

# Current release: v1.7.3
# AX constitution: docs/AX.md
# 13 AX ratchet tests in CI
# All formats (json/text/yaml) AX-equivalent since v1.7.3

# Install latest (once v1.7.3 CI builds):
curl -fsSL https://raw.githubusercontent.com/DennisDyallo/vslsp/main/install.sh | bash -s -- --yes
vslsp --version  # → 1.7.3

# Reinstall Rust mapper (404 on patch releases — use v1.7.0 asset directly):
# gh release download v1.7.0 --pattern "RustMapper-darwin-arm64" -D ~/.local/share/vslsp/rust-mapper/
# chmod +x ~/.local/share/vslsp/rust-mapper/RustMapper

# Prune stale session worktrees:
git worktree prune
```
