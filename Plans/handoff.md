# Handoff — main

**Date:** 2026-04-03
**Branch:** main
**Last commit:** 6d6c3e0 Fix GitHub Actions versions: checkout@v6, setup-dotnet@v5, upload@v7, download@v8

---

## Session Summary

Two commits this session on top of v0.2.0:

**fd6445c** — Major improvements batch:
- MCP real fix: Claude Code reads `~/.claude.json` not `~/.mcp.json`; vslsp registered correctly; `install.sh` now has `configure_mcp()` writing to `~/.claude.json` via python3
- `start_daemon` PATH fix: uses `DEFAULT_VSLSP` absolute path (`~/.local/share/vslsp/vslsp`), not bare `"vslsp"` string
- `stop_daemon` MCP tool: `POST /stop` endpoint in daemon HTTP server, `stop()` in client, 8th tool in MCP server
- CodeMapper `--stdout` mode: `get_code_structure` now returns full AST JSON (not summary string)
- Extensible mapper architecture: `src/code-mapping/registry.ts` with `LanguageMapper` interface; C# + Rust stub; `language` param in MCP and CLI
- GitHub Actions upgraded: `checkout@v6`, `setup-dotnet@v5`, `upload-artifact@v7`, `download-artifact@v8`
- macOS quarantine clearing in `install.sh` after every binary download

**6d6c3e0** — CI hotfix: corrected action versions (each action has independent versioning — blanket @v6 broke `setup-dotnet` which has no v6)

**v0.3.0 released:** 11 assets on GitHub (vslsp, vslsp-mcp ×4 platforms, CodeMapper ×3 platforms).

**MCP confirmed working:** `/mcp` shows vslsp connected after adding to `~/.claude.json`. Permanently resolved.

---

## Current State

### Committed & Pushed
All source changes are on `main`. v0.3.0 tag is live.

```
6d6c3e0  Fix GitHub Actions versions
fd6445c  Add extensible mapper registry, stop_daemon, CodeMapper stdout mode, MCP fix
```

### Uncommitted
Only `Plans/handoff.md` (this file) and untracked plan docs in `Plans/`.

### Build & Install Status
- Type check: Clean
- MCP server: 8 tools (confirmed live in Claude Code this session)
- All binaries rebuilt and deployed locally
- v0.3.0: 11/11 assets published on GitHub

### Globally Installed
- `~/.local/share/vslsp/vslsp` — with DEFAULT_VSLSP, language routing
- `~/.local/share/vslsp/vslsp-mcp` — 8 tools including stop_daemon
- `~/.local/share/vslsp/code-mapper/CodeMapper` — --stdout mode
- `~/.claude.json` — vslsp MCP entry registered under mcpServers

---

## Readiness Assessment

**Target:** AI agents (Claude Code, Copilot, Cursor) working on C# codebases needing compilation diagnostics and code structure awareness.

| Need | Status | Notes |
|---|---|---|
| Get ALL C# compilation errors at once | ✅ | One-shot and daemon modes |
| Map C# code structure (full AST JSON) | ✅ | --stdout mode; get_code_structure returns complete data |
| Persistent daemon with file watching | ✅ | Auto-detects .cs changes, debounced |
| MCP server auto-discovered by Claude Code | ✅ | Registered in ~/.claude.json |
| start_daemon works without vslsp in PATH | ✅ | Uses DEFAULT_VSLSP absolute path |
| stop_daemon via MCP | ✅ | POST /stop + stop_daemon tool |
| Multi-language mapper extensibility | ✅ | Registry + language param wired; Rust stub ready |
| Notify daemon of file changes via MCP | ✅ | notify_file_changed tool |
| Dry-run verify refactorings | ✅ | verify_changes tool, tested E2E |
| Global install from any machine | ✅ | install.sh + configure_mcp() + quarantine clearing |
| Rust code structure mapping | ⚠️ | Architecture ready; binary not built yet |
| Test install.sh on clean machine | ⚠️ | Not validated end-to-end on fresh system |

**Overall:** 🟢 Production — all core C# functionality works, released, MCP connected. Rust mapper is the only missing capability.

**Critical next step:** Build the RustMapper binary (`tools/rust-mapper/`).

---

## RustMapper Plan (next major work)

**Plan file:** `Plans/distributed-juggling-hedgehog.md`

Key decisions already made:
- Uses `syn` crate (visitor pattern, like CSharpSyntaxWalker) + `rayon` for parallel parsing
- Detects `Cargo.toml` files to group output by crate (like CodeMapper groups by `.csproj`)
- Follows `mod foo;` external module references to `foo.rs` / `foo/mod.rs`
- Skips: `target/`, `.git/`, `tests/`, `examples/`, `benches/`
- Parse failures: `eprintln!` + continue (never panic)
- CI: `build-rust-mapper` job in `release.yml` with `actions/cache@v4` for Cargo (syn compiles slowly)
- Output schema: identical to CodeMapper `OutputRoot` JSON

**CI lesson learned this session:** Each GitHub Action has independent versioning. Never blanket-upgrade. Verify each action separately via `gh api repos/actions/{name}/releases/latest`.

---

## What's Next (Prioritized)

1. **Build RustMapper** — create `tools/rust-mapper/Cargo.toml` and `src/main.rs` per the plan in `Plans/distributed-juggling-hedgehog.md`
2. **Add `build-rust-mapper` CI job** — add to `release.yml`, update `needs` in `release` job, add Cargo cache step
3. **Test install.sh on clean machine** — validate `configure_mcp()` correctly merges `~/.claude.json` without corrupting it
4. **Tag v0.4.0** after RustMapper is built, tested, and CI publishes `RustMapper-*` assets
5. **darwin-x64 CodeMapper** — currently missing from release (Rosetta works, but native binary would be cleaner)

## Blockers & Known Issues

- **Rust mapper binary absent** — `language:"rust"` MCP call fails with "binary not found." Registry, install stub, and CI job structure are all ready — just needs the binary.
- **`syn` compile time** — first CI build of RustMapper will be slow (60–90s). Cargo cache step mitigates subsequent runs.
- **install.sh not tested on clean machine** — the `configure_mcp()` python3 JSON merge is untested in the wild. If the user's `~/.claude.json` is non-standard, it could fail silently.

## Key File References

| File | Purpose |
|------|---------|
| `Plans/distributed-juggling-hedgehog.md` | RustMapper plan — full spec, Cargo.toml, CI job, schema |
| `mcp.ts` | MCP server — 8 tools |
| `src/code-mapping/registry.ts` | Language registry — add entries here for new languages |
| `src/code-mapping/mapper.ts` | Routes by language, passes --stdout |
| `src/core/defaults.ts` | DEFAULT_VSLSP, DEFAULT_RUST_MAPPER, DEFAULT_CODE_MAPPER |
| `src/diagnostics/http.ts` | HTTP server — POST /stop |
| `src/diagnostics/client.ts` | HTTP client — stop() |
| `tools/code-mapper/Program.cs` | C# AST analyzer — --stdout mode |
| `install.sh` | configure_mcp() → ~/.claude.json; quarantine clearing |
| `~/.claude.json` | Global Claude Code config — vslsp MCP registered |
| `.github/workflows/release.yml` | Release pipeline — add build-rust-mapper job here |

---

## Quick Start for New Agent

```bash
cd /Users/Dennis.Dyall/Code/other/vslsp

# Verify state
git log --oneline -3
bun run tsc --noEmit
grep -c "registerTool" mcp.ts  # should be 8

# Read the RustMapper plan
cat Plans/distributed-juggling-hedgehog.md

# Start building RustMapper
mkdir -p tools/rust-mapper/src
# Create tools/rust-mapper/Cargo.toml and tools/rust-mapper/src/main.rs per plan
```
