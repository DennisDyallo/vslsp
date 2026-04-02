# Handoff — main

**Date:** 2026-04-02
**Branch:** main
**Last commit:** (pending commit of this session's work)

---

## Session Summary

Implemented six improvements post-v0.2.0:
1. **MCP quarantine fix** — cleared macOS quarantine xattr from installed binaries; updated `install.sh` to clear quarantine after every binary download (darwin only)
2. **start_daemon PATH fix** — `mcp.ts` now spawns vslsp via `DEFAULT_VSLSP` absolute path, not bare `"vslsp"` string
3. **stop_daemon MCP tool** — new tool stops running daemon via `POST /stop`; backed by new `http.ts` route and `client.ts#stop()`
4. **CodeMapper stdout mode** — `--stdout` flag added to `Program.cs`; `mapper.ts` passes it by default; `get_code_structure` now returns full structured JSON AST, not summary string
5. **Extensible mapper architecture** — `src/code-mapping/registry.ts` with `LanguageMapper` interface; C# and Rust (stub) registered; `mapper.ts` routes by language or auto-detects from extension; `mcp.ts` and `vslsp.ts` accept `language` param; `install.sh` has `download_rust_mapper()` stub
6. **GitHub Actions v6** — all `actions/checkout`, `setup-dotnet`, `upload-artifact`, `download-artifact` upgraded from @v4 to @v6

## Current State

### Uncommitted Changes
All work is locally done but NOT committed. Need to commit before pushing.

Modified files:
- `src/core/defaults.ts` — added `DEFAULT_VSLSP`, `DEFAULT_RUST_MAPPER`
- `src/diagnostics/http.ts` — added `POST /stop` endpoint
- `src/diagnostics/client.ts` — added `stop()` function
- `src/code-mapping/mapper.ts` — language routing + `--stdout` flag
- `mcp.ts` — imports, start_daemon PATH fix, stop_daemon tool, get_code_structure language param
- `vslsp.ts` — `--language` flag, HELP text
- `install.sh` — quarantine clearing, `download_rust_mapper()` stub
- `tools/code-mapper/Program.cs` — `--stdout` mode, `WriteTextToWriter`/`WriteYamlToWriter` helpers
- `.github/workflows/build.yml` — actions @v4 → @v6
- `.github/workflows/release.yml` — actions @v4 → @v6

New files:
- `src/code-mapping/registry.ts` — language registry

### Build & Test Status
- Type check: Clean (`bun run tsc --noEmit`)
- CodeMapper stdout mode: Verified — `--format json --stdout` outputs full JSON AST to stdout
- vslsp `map` command: Verified — `--language csharp` works, JSON output correct
- MCP server: 8 tools registered (was 7)
- Deployed: All binaries updated in `~/.local/share/vslsp/`
- Quarantine cleared from all installed binaries

### Globally Installed
- `~/.local/share/vslsp/vslsp` — rebuilt with language routing
- `~/.local/share/vslsp/vslsp-mcp` — rebuilt with stop_daemon tool (8 tools)
- `~/.local/share/vslsp/code-mapper/CodeMapper` — rebuilt with --stdout support

---

## Readiness Assessment

| Need | Status | Notes |
|---|---|---|
| MCP server auto-connects in Claude Code | ✅ Fixed | Quarantine cleared; install.sh now handles this |
| start_daemon works without vslsp in PATH | ✅ Fixed | Uses DEFAULT_VSLSP absolute path |
| stop_daemon via MCP | ✅ Done | POST /stop endpoint + stop_daemon tool |
| get_code_structure returns full JSON | ✅ Fixed | --stdout mode; full AST in MCP response |
| Multi-language mapper extensibility | ✅ Done | Registry, auto-detect, language param |
| GitHub Actions current | ✅ Done | @v4 → @v6 |
| Rust mapper binary | ⚠️ Stub | install.sh downloads if present in release; no Rust mapper binary exists yet |
| Commit + push | ❌ Pending | Changes not yet committed |

---

## What's Next (Prioritized)

1. **Commit and push** — all changes ready, just need a commit
2. **Test MCP reconnect** — restart Claude Code session, verify `/mcp` shows vslsp connected and 8 tools appear
3. **Release v0.3.0** — tag to trigger release workflow with updated GH Actions
4. **Build Rust mapper** — `tools/rust-mapper/` Cargo project using `syn` or `tree-sitter-rust`, outputting same JSON schema
5. **Test install.sh on clean machine** — validate full install path end-to-end

## Blockers & Known Issues

- **Rust mapper binary doesn't exist yet** — `registry.ts` has the entry, install.sh has the stub, but no actual binary. Calling `get_code_structure` with `language:"rust"` will fail with "binary not found".
- **GitHub Actions v6 compatibility** — upgraded but not yet tested in CI. If v6 has breaking changes (especially `upload-artifact` API changes), the release workflow may need adjustments.

## Key File References

| File | Purpose |
|------|---------|
| `mcp.ts` | MCP server — now 8 tools |
| `src/code-mapping/registry.ts` | Language registry (NEW) |
| `src/code-mapping/mapper.ts` | Language-routing mapper + --stdout |
| `src/core/defaults.ts` | Paths: DEFAULT_VSLSP, DEFAULT_RUST_MAPPER added |
| `src/diagnostics/http.ts` | HTTP server — POST /stop added |
| `src/diagnostics/client.ts` | HTTP client — stop() added |
| `tools/code-mapper/Program.cs` | C# AST analyzer — --stdout mode added |
| `install.sh` | Installer — quarantine clear + download_rust_mapper stub |
| `.github/workflows/build.yml` | CI — @v6 |
| `.github/workflows/release.yml` | Release — @v6 |
