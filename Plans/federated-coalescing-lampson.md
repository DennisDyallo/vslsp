# Plan: Unified get_diagnostics + vslsp Integration Test Skill

## Context

Two problems to solve together:

1. **API inconsistency**: Three separate per-language diagnostic tools (`get_diagnostics` C#-only, `get_rust_diagnostics`, `get_ts_diagnostics`) when `get_code_structure` auto-detects language from a single `path` param. Agents must know the language before calling. Unify into one `get_diagnostics`, reducing tools 10 → 8.

2. **Missing integration skill**: No standardized runbook for running vslsp MCP tools against real external codebases. Create `/vslsp-integration` skill.

---

## MCP SDK Constraint (v1.29.0)

**`z.union` does NOT work as `inputSchema`.** The SDK's `normalizeObjectSchema` returns `undefined` for union schemas, causing `tools/list` to expose `EMPTY_OBJECT_JSON_SCHEMA` for that tool — breaking schema discovery for all agents. Confirmed by reading `zod-compat.js:normalizeObjectSchema`.

`inputSchema` must be a Zod **object** schema (has `.shape`) for proper serialization.

**Therefore: true method overloading at the Zod level is not achievable in MCP v1.29.0.** The cleanest achievable design within constraints is discriminant optional fields — callers pick their "overload" by which primary param they provide.

---

## Part 1: Unified `get_diagnostics` Design

### Schema (discriminant-field overloads)

Three "overloads" via distinct optional primary fields. Exactly one must be provided. Runtime `.refine()` enforces this. Each primary field name is self-documenting about language.

```typescript
const GetDiagnosticsSchema = z.object({
  // === Provide exactly one of these (selects language + runtime): ===
  solution: z.string().optional().describe(
    "C#: absolute path to .sln file. Provide this OR manifest OR project."
  ),
  manifest: z.string().optional().describe(
    "Rust: path to Cargo.toml or directory containing one. Provide this OR solution OR project."
  ),
  project: z.string().optional().describe(
    "TypeScript: path to tsconfig.json or directory containing one. Provide this OR solution OR manifest."
  ),

  // === Shared (all languages): ===
  file: z.string().optional().describe("Filter diagnostics to a single source file path."),

  // === C#-only (ignored for Rust/TypeScript): ===
  timeout: z.number().optional().default(60000).describe("C# only. Max wait in ms for OmniSharp."),
  quiet_period: z.number().optional().default(5000).describe("C# only. Wait after last diagnostic."),
  use_daemon: z.boolean().optional().default(false).describe("C# only. Query running daemon."),
  port: z.number().optional().default(DEFAULT_PORT).describe("C# only. Daemon port."),

  // === Rust-only (ignored for C#/TypeScript): ===
  package: z.string().optional().describe("Rust only. Workspace member name."),
  all_targets: z.boolean().optional().default(false).describe("Rust only. Include test/bench targets."),
}).refine(
  (args) => [args.solution, args.manifest, args.project].filter(Boolean).length === 1,
  { message: "Provide exactly one of: solution (C#), manifest (Rust), or project (TypeScript)." }
);
```

### Handler routing

```typescript
async (args) => {
  if (args.solution) { /* existing C# DiagnosticsCollector logic, solution = args.solution */ }
  else if (args.manifest) { /* collectRustDiagnostics({ manifest: args.manifest, ... }) */ }
  else { /* collectTsDiagnostics({ project: args.project!, ... }) */ }
}
```

### Why this is NOT a god signature

- From a **caller's** perspective there are three clean call patterns:
  - `{ solution: "...", [use_daemon, port, ...] }`  → C#
  - `{ manifest: "...", [package, all_targets] }` → Rust
  - `{ project: "..." }` → TypeScript
- Language-specific params are labeled "C# only" / "Rust only" in descriptions — agents know which to ignore
- `.refine()` gives a clear error if a caller mixes overloads
- This is the standard pattern in JSON Schema / OpenAPI for polymorphic endpoints where `oneOf` isn't reliably supported by the consumer

`get_diagnostics_summary` stays C#-only (daemon-specific; no Rust/TS equivalent).

---

## Files to Modify

### Part 1 — API Unification

| File | Change |
|------|--------|
| `mcp.ts` | Replace 3 tools with 1 unified `get_diagnostics` using schema above. `registerTool` count: 10 → 8. |
| `tests/e2e/mcp-server.test.ts` | Remove `get_rust_diagnostics` + `get_ts_diagnostics` from `EXPECTED_TOOLS`. Fix `toBeArrayOfSize(10)` → `(8)` (lines 172, 569). Update all `name:` and param names (`manifest:` stays, `project:` → stays, but tool name changes). |
| `package.json` | Bump version 1.3.0 → 1.4.0 |
| `CLAUDE.md` (project) | "Tools: **10**" → "Tools: **8**". Update tool reference table + per-language workflow tables. |
| `README.md` | Update all 7+ references to `get_rust_diagnostics`/`get_ts_diagnostics` → `get_diagnostics`. |
| `skills/vslsp/SKILL.md` | "10 tools" → "8 tools". Update Rust + TS workflow tool call names. Update decision table. |

### Part 2 — Integration Skill

| File | Change |
|------|--------|
| `~/.claude/skills/vslsp-integration/SKILL.md` | **CREATE** — new skill |

---

## Test Changes (e2e/mcp-server.test.ts)

```typescript
// BEFORE:
const EXPECTED_TOOLS = [
  "get_diagnostics", "get_diagnostics_summary",
  "get_code_structure", "start_daemon", "get_daemon_status",
  "stop_daemon", "notify_file_changed", "verify_changes",
  "get_rust_diagnostics",    // ← remove
  "get_ts_diagnostics",      // ← remove
];
expect(tools).toBeArrayOfSize(10); // → (8)

// AFTER:
const EXPECTED_TOOLS = [
  "get_diagnostics", "get_diagnostics_summary",
  "get_code_structure", "start_daemon", "get_daemon_status",
  "stop_daemon", "notify_file_changed", "verify_changes",
  // Rust + TS diagnostics now unified into get_diagnostics
];
expect(tools).toBeArrayOfSize(8);

// Tool call updates:
{ name: "get_ts_diagnostics", arguments: { project: FIXTURE_DIR } }
  → { name: "get_diagnostics", arguments: { project: FIXTURE_DIR } }

{ name: "get_rust_diagnostics", arguments: { manifest: join(..., "tools/rust-mapper") } }
  → { name: "get_diagnostics", arguments: { manifest: join(..., "tools/rust-mapper") } }
```

---

## Integration Skill: Targets + Coverage

**Targets:**

| Language | Repo | Path |
|----------|------|------|
| TypeScript | Skattata | `/Users/Dennis.Dyall/Code/other/Skattata` |
| Rust | octo-rdt-prototype | `/Users/Dennis.Dyall/Code/y/octo-rdt-prototype` |
| C# | Yubico.NET.SDK | `/Users/Dennis.Dyall/Code/y/Yubico.NET.SDK/Yubico.YubiKit.sln` |

**Fallback:** `tools/ts-mapper/` (TS), `tools/rust-mapper/` (Rust). C# skipped if Yubico not present.

**Tool coverage (all 8):**

| Tool | TS | Rust | C# |
|------|---|---|---|
| `get_code_structure` | ✓ | ✓ | ✓ |
| `get_diagnostics` (unified) | ✓ | ✓ | ✓ |
| `get_diagnostics_summary` | — | — | ✓ |
| `start_daemon` | — | — | ✓ |
| `get_daemon_status` | — | — | ✓ |
| `verify_changes` | — | — | ✓ |
| `notify_file_changed` | — | — | ✓ |
| `stop_daemon` | — | — | ✓ |

---

## Execution Order

1. Bump `package.json` version 1.3.0 → 1.4.0
2. Rewrite unified `get_diagnostics` in `mcp.ts` (remove 2 old registrations, update 1)
3. Verify: `grep -c "registerTool" mcp.ts` = 8
4. Update `tests/e2e/mcp-server.test.ts` (tool list, counts, call names)
5. Update docs: `CLAUDE.md`, `README.md`, `skills/vslsp/SKILL.md`
6. Run `bun run tsc --noEmit` → clean
7. Run `bun test` → all pass
8. Create `~/.claude/skills/vslsp-integration/SKILL.md`

---

## Verification

```bash
grep -c "registerTool" mcp.ts          # must print 8
bun run tsc --noEmit                    # must be clean
bun test                                # 57+ pass, 0 fail
```

Post-skill: invoke `/vslsp-integration` and confirm all 8 tools exercise cleanly across 3 languages.
