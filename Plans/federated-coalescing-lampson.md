# Plan: Unified get_diagnostics + vslsp Integration Test Skill

**Status: COMPLETE — v1.5.1 released 2026-04-09. AX byte-budget truncation shipped (5278b3f), 9 contract tests in CI (37db623), 70 tests pass.**
**All phases complete: P1 (unification), P2 (filtering), P3 (contract tests), P4 (AX auto-truncation). Verified against 3 real codebases.**
**AX philosophy canonical reference:** see `docs/AX.md`

---

# Phase 3: AX Contract Integration Tests

## Context

vslsp v1.5.0 added output filtering (`depth`, `file_filter`, `max_files`, `severity`, `limit`) after real-world feedback: unfiltered tool responses on large codebases return 3–5MB of JSON, consuming an agent's entire context window in a single call. This renders the tools unusable for the use case they were built for.

**The explicit AX goal:** A tool call must never return enough data to meaningfully pollute an agent's context window. "Never degrade" means: once we ship filtering, a future regression that silently bloats output back to 5MB must *fail CI*. Tests must encode the contract, not just demonstrate that filters exist.

**The contract has two halves — both must be tested:**
1. **Lower bound**: Filtered results must contain real data (not empty because the filter broke)
2. **Upper bound**: Filtered results must be within the context window budget

This is a "lock box" invariant: tests fail if output gets too large AND if output gets too small.

---

## Token Budget Thresholds (with reasoning)

- Claude Sonnet: ~200K tokens total context
- Safe single MCP response: **≤ 50KB** — leaves room for conversation, system prompt, other calls
- Acceptable focused response: **≤ 200KB** — for a deliberate "load this file tree" call with `depth: "signatures"`
- Context bomb threshold: **> 500KB** — what unfiltered `depth: "full"` returns on real codebases

| Filter combo | Budget | Why |
|---|---|---|
| `depth: "types"` | < 30KB | Type names only — should be tiny |
| `depth: "signatures"` | < 200KB | Types + method sigs — usable |
| `file_filter` + `max_files: 5` | < 50KB | Focused subtree |
| `severity: "error", limit: 20` | < 10KB | 20 errors fits in a response |
| Unfiltered `depth: "full"` | > unfiltered_signatures | Proves the fixture is real |

---

## File Locations

### Tests go in: `tests/e2e/mcp-server.test.ts`

**Extend existing describe blocks:**
- `describe("get_code_structure via MCP", () => {` — **lines 347–462** — add nested describe for filter tests
- `describe("get_diagnostics (TypeScript) via MCP", () => {` — add severity + limit tests

**Existing helpers to reuse:**
- `parseToolResult(result)` (lines 41–45) — returns parsed JSON; use `JSON.stringify(data).length` for byte size
- `expectDiagnosticsResultSchema(data)` (lines 51–73) — validates DiagnosticsResult shape
- `expectDiagnosticEntrySchema(entry)` (lines 78–93) — validates individual diagnostic entry
- `client.callTool({ name, arguments })` — standard MCP tool invocation pattern
- `PROJECT_ROOT` — vslsp root directory (valid TypeScript project fixture)
- `FIXTURE_DIR` — `tests/fixtures/e2e-ts-project/` — has `src/broken.ts` with intentional errors

### Fixture to add: temp directory for warning test
Create in `beforeAll` of nested describe: a directory with only a `.txt` file (no manifests, no source files). Delete in `afterAll`. This triggers auto-detection failure → `warning` field in response.

---

## Test Cases (9 total, grouped)

### Group A: get_code_structure — depth filtering (add to existing describe)

```
describe("output filtering — AX context window contract")
```

**Test A1: depth "types" produces smaller output than "full" AND fits 30KB budget**
```typescript
// Call with depth: "full"
const full = await client.callTool({ name: "get_code_structure",
  arguments: { path: PROJECT_ROOT, language: "typescript", depth: "full" } });
const fullSize = full.content[0].text.length;

// Call with depth: "types"  
const typed = await client.callTool({ name: "get_code_structure",
  arguments: { path: PROJECT_ROOT, language: "typescript", depth: "types" } });
const typesData = parseToolResult(typed);
const typesSize = typed.content[0].text.length;

expect(typesSize).toBeLessThan(fullSize);          // filter reduces output
expect(typesSize).toBeLessThan(30_000);            // AX upper bound: 30KB
expect(typesData.files.length).toBeGreaterThan(0); // lower bound: real data
// Members at "types" depth have no Method/Constructor children
for (const file of typesData.files) {
  for (const member of file.members) {
    for (const child of member.children ?? []) {
      expect(["Class","Struct","Interface","Enum","Record","Mod","Trait","Namespace","Type"])
        .toContain(child.type); // no Method/Fn/Constructor at types depth
    }
  }
}
```

**Test A2: depth "signatures" satisfies 200KB context window budget with real data**
```typescript
const result = await client.callTool({ name: "get_code_structure",
  arguments: { path: PROJECT_ROOT, language: "typescript", depth: "signatures" } });
const data = parseToolResult(result);
const size = result.content[0].text.length;

expect(size).toBeLessThan(200_000);                   // AX upper bound
expect(data.files.length).toBeGreaterThan(0);         // lower bound: real data
expect(data.summary.methods).toBeGreaterThan(0);      // has method signatures
// Children of members have no further children (grandchildren stripped)
for (const file of data.files) {
  for (const member of file.members) {
    for (const child of member.children ?? []) {
      expect(child.children).toHaveLength(0);         // grandchildren stripped
    }
  }
}
```

**Test A3: file_filter scopes results to matching files only**
```typescript
const result = await client.callTool({ name: "get_code_structure",
  arguments: { path: PROJECT_ROOT, language: "typescript", file_filter: "src/**" } });
const data = parseToolResult(result);

expect(data.files.length).toBeGreaterThan(0);
for (const file of data.files) {
  expect(file.filePath).toMatch(/^src\//); // all files are in src/
}
```

**Test A4: max_files caps returned file count**
```typescript
const result = await client.callTool({ name: "get_code_structure",
  arguments: { path: PROJECT_ROOT, language: "typescript", max_files: 2 } });
const data = parseToolResult(result);

expect(data.files.length).toBeLessThanOrEqual(2);
expect(data.summary.files).toBeLessThanOrEqual(2);
```

**Test A5: warning field emitted when auto-detection returns 0 files**
```typescript
// In beforeAll: mkdirSync(EMPTY_DIR); writeFileSync(join(EMPTY_DIR, "notes.txt"), "no source here");
// In afterAll: rmSync(EMPTY_DIR, { recursive: true });

const result = await client.callTool({ name: "get_code_structure",
  arguments: { path: EMPTY_DIR } }); // NO language param — triggers auto-detection failure
const data = parseToolResult(result);

expect(data.summary.files).toBe(0);
expect(data.warning).toBeDefined();
expect(data.warning).toContain("auto-detected");
expect(data.warning).toContain("language:");
```

---

### Group B: get_diagnostics — severity + limit filtering (add to TypeScript diagnostics describe)

**Test B1: severity "error" returns only error-severity diagnostics**
```typescript
// FIXTURE_DIR has src/broken.ts with intentional TypeScript errors
const result = await client.callTool({ name: "get_diagnostics",
  arguments: { project: FIXTURE_DIR, severity: "error" } });
const data = parseToolResult(result);

expectDiagnosticsResultSchema(data);
expect(data.summary.warnings).toBe(0);
expect(data.summary.info).toBe(0);
expect(data.summary.hints).toBe(0);
// All returned entries are errors
for (const file of data.files) {
  for (const diag of file.diagnostics) {
    expect(diag.severity).toBe("error");
  }
}
```

**Test B2: limit caps total diagnostic count across all files**
```typescript
const result = await client.callTool({ name: "get_diagnostics",
  arguments: { project: FIXTURE_DIR, limit: 1 } });
const data = parseToolResult(result);

expectDiagnosticsResultSchema(data);
const totalDiags = data.files.reduce((sum: number, f: any) => sum + f.diagnostics.length, 0);
expect(totalDiags).toBeLessThanOrEqual(1);
```

**Test B3: severity + limit combine (first N errors only)**
```typescript
const result = await client.callTool({ name: "get_diagnostics",
  arguments: { project: FIXTURE_DIR, severity: "error", limit: 2 } });
const data = parseToolResult(result);

const totalDiags = data.files.reduce((sum: number, f: any) => sum + f.diagnostics.length, 0);
expect(totalDiags).toBeLessThanOrEqual(2);
for (const file of data.files) {
  for (const diag of file.diagnostics) {
    expect(diag.severity).toBe("error"); // severity filter still applies within limit
  }
}
```

**Test B4: severity + limit response fits in AX budget (< 10KB)**
```typescript
const result = await client.callTool({ name: "get_diagnostics",
  arguments: { project: FIXTURE_DIR, severity: "error", limit: 20 } });
const size = result.content[0].text.length;

expect(size).toBeLessThan(10_000); // 20 errors must fit in 10KB
```

---

## Implementation Notes

### Using `result.content[0].text.length` for byte size
`parseToolResult()` discards the raw string. For size assertions, read the raw length BEFORE parsing:
```typescript
const rawText = result.content[0].text;
const size = rawText.length; // byte count (UTF-8 overhead acceptable for this purpose)
const data = JSON.parse(rawText);
```

### beforeAll structure for warning test (temp dir)
Add inside a nested `describe("warning field on auto-detection failure")`:
```typescript
const EMPTY_DIR = join(PROJECT_ROOT, "tests", "fixtures", "_empty_autodetect_test");
beforeAll(() => {
  mkdirSync(EMPTY_DIR, { recursive: true });
  writeFileSync(join(EMPTY_DIR, "notes.txt"), "no source files here");
});
afterAll(() => {
  rmSync(EMPTY_DIR, { recursive: true, force: true });
});
```

### Imports to add
```typescript
import { mkdirSync, writeFileSync, rmSync } from "fs";
```
(Other fs imports are likely already present)

### Test timeouts
- Depth/filter tests: `}, 30_000)` — mapper runs are fast, but allow buffer
- Severity/limit tests: `}, 30_000)` — tsc runs are fast on the small fixture

---

## Verification

After implementing:
```bash
bun test tests/e2e/mcp-server.test.ts --timeout 60000
# Must show 9 new passes (total ~68 pass, 0 fail)

# Spot-check the byte budget manually:
bun -e "
const { map } = await import('./src/code-mapping/mapper.ts');
const r = await map({ path: '.', language: 'typescript', depth: 'signatures' });
console.log('size:', r.output.length, 'bytes');
"
```

The "never regress" guarantee: if a future change makes `depth: "signatures"` on the vslsp codebase return > 200KB, **Test A2 fails**. If a future change makes filters return empty, **the lower bound assertions fail**. The tests act as a two-way ratchet.

---

## Missing from v1.5.0: Docs Update (also part of this plan)

The feedback was: "The README should lead with the verify workflow, not the code structure tool." `CLAUDE.md` was updated but **`README.md` and `skills/vslsp/SKILL.md` were not**. The integration skill also still calls `get_code_structure` without filters.

### Files to update

#### `README.md`
- Move `verify_changes` + `get_diagnostics_summary` to the top of the "Usage" / "Workflow" section
- Add the filter params to the `get_code_structure` usage examples with concrete recommendations:
  - "Always use `depth: "signatures"` for directories"
  - "Use `file_filter` to scope to a subtree"
  - "Auto-detection may fail on directories — pass `language:` explicitly"
- Add `severity` and `limit` to `get_diagnostics` examples

#### `skills/vslsp/SKILL.md`
Incorporate the agent's real-world "when would I use it" hierarchy as the new decision table:

| Scenario | Tool | Params |
|---|---|---|
| Pre-write C# safety check | `verify_changes` | Always, after daemon ready |
| Quick error count | `get_diagnostics_summary` | `use_daemon: true` |
| Errors after writing | `get_diagnostics` | `severity: "error", limit: 20` |
| Understand unfamiliar code | `get_code_structure` | `depth: "signatures", max_files: 20` |
| Find types in a subtree | `get_code_structure` | `depth: "types", file_filter: "src/Core/**"` |

Add explicit warning at the top of the `get_code_structure` section:
> ⚠️ Always use `depth: "signatures"` for directories. `depth: "full"` on a real codebase returns 3–5MB — larger than most agent context windows. Never call without a depth or filter param on a project directory.

#### `~/.claude/skills/vslsp-integration/SKILL.md`
The integration skill calls `get_code_structure({ path })` without depth — it will hit context bombs on real codebases. Update all Phase 1, 2, 3 `get_code_structure` calls to use `depth: "signatures"`. Keep `language:` explicit (already done from previous fix).

### Order of execution
1. Implement the 9 tests (above) → commit
2. Update `README.md` → commit
3. Update `skills/vslsp/SKILL.md` → commit  
4. Update `~/.claude/skills/vslsp-integration/SKILL.md` → commit
5. `bun run release 1.5.0`

---

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
