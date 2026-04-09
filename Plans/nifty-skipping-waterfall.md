# Plan: AX Constitution + uninstall-mapper + http.test.ts Rewrite

**Branch:** main | **Date:** 2026-04-09 | **Target version:** v1.6.0

---

## Execution Model: 3 Parallel Sub-Agents

These three deliverables are fully independent — no shared files, no ordering constraints. After plan approval, three Engineer agents execute concurrently in isolated worktrees, each owning one domain. Results are merged.

| Workstream | Agent | Domain | Files touched |
|-----------|-------|--------|---------------|
| **W1 — AX Constitution** | Engineer (docs) | Documentation | `docs/AX.md`, `CLAUDE.md`, `Plans/federated-coalescing-lampson.md` |
| **W2 — uninstall-mapper** | Engineer (CLI) | vslsp.ts CLI | `vslsp.ts` only |
| **W3 — http.test.ts** | Engineer (test) | Test behavior | `tests/http.test.ts` only |

Each agent has its own sub-plan below. No cross-agent dependencies.

---

## Context

Three deliverables, all guided by the same principle: **agent experience (AX) is paramount**.

1. **AX Constitution** — The existing AX philosophy is scattered across `Plans/federated-coalescing-lampson.md`, code comments, and tests. There is no canonical document an agent or developer can read to understand _why_ vslsp makes the design decisions it does, what the inviolable contracts are, and how to stay compliant when extending the tool. This is the most leveraged deliverable: it shapes every future change.

2. **`vslsp uninstall-mapper <lang>`** — Install has no removal path. Once a mapper is installed, the only way to remove it is manual filesystem surgery. This is a broken DX story and a gap in the CLI surface.

3. **`http.test.ts` rewrite** — The current tests check source-code strings, not actual HTTP behavior. They provide false confidence: a completely broken HTTP server would pass them. Real behavior tests protect the daemon API that agents depend on.

---

## ISC (Ideal State Criteria)

- [ ] `docs/AX.md` exists, covers: goal, budget thresholds, principles, tool schema guidance, error message standards, CI enforcement, extension checklist
- [ ] `vslsp uninstall-mapper <lang>` removes the correct directory, exits 0 if not installed, exits 1 on unknown language
- [ ] `vslsp uninstall-mapper` appears in `vslsp --help` output
- [ ] `tests/http.test.ts` makes real HTTP requests, asserts status codes and JSON response bodies
- [ ] All 8+ HTTP routes have at least one success test and one failure/edge-case test
- [ ] `bun run tsc --noEmit` clean after all changes
- [ ] `bun test --timeout 60000` green (70+ pass, 0 fail)

---

## Deliverable 1: AX Constitution (`docs/AX.md`)

### File to create
`docs/AX.md` — new file, canonical reference

### Structure

```
# vslsp AX Constitution

## The AX Guarantee
(One paragraph: core contract — tool calls must never pollute agent context window)

## Budget Thresholds
(Table: same thresholds from federated-coalescing-lampson.md, with reasoning)

## Design Principles
1. Filter by default, not by exception
2. Warn with agent-actionable messages (not just what — what to do next)
3. Tool schemas describe the filtering surface, not the data surface
4. Never return 0 files silently — warn when filters produce empty results
5. Ratchet tests lock every contract in CI

## Tool Schema Standards
- `description` field must tell agents WHEN to use this tool and HOW to scope it
- Parameter descriptions must include the AX implication (e.g. "without this filter, response may exceed context window budget")
- Error messages must include the corrective action, not just the error

## Error Message Standard
(Template: "[What went wrong]. [What the agent should do next]. Example: ...")

## CI Enforcement
(How AX contract tests work — dual bound: lower + upper)

## Extension Checklist
(For any new tool or language: what AX obligations must be met)
```

### Cross-references
- Update `Plans/federated-coalescing-lampson.md` status line to reference `docs/AX.md` as the canonical doc
- Update `CLAUDE.md` Agent Quick-Start to mention AX.md

---

## Deliverable 2: `vslsp uninstall-mapper <lang>`

### Files to modify
- `vslsp.ts` — add command type, arg parsing, function, help text

### Implementation

**Step 1 — Command type** (`vslsp.ts:81`)
```typescript
type Command = "serve" | "query" | "status" | "notify" | "map" | "install-mapper" | "uninstall-mapper" | "oneshot";
```

**Step 2 — Arg parsing** (in `parseArgs()`, after the install-mapper block, around line 130)
```typescript
} else if (firstArg === "uninstall-mapper") {
  result.command = "uninstall-mapper";
  args.shift();
  result.installLang = args[0] && !args[0].startsWith("-") ? args.shift()! : "";
}
```
Note: `installLang` is already in the `CLIArgs` interface (shared with install-mapper).

**Step 3 — Function** (add after `installMapper()`, around line 246)
```typescript
async function uninstallMapper(language: string): Promise<void> {
  const m = getMapper(language);
  if (!m) {
    console.error(`Unknown language: ${language}\nSupported: csharp, rust, typescript`);
    process.exit(1);
  }

  const installDir = m.installDir; // absolute path from registry
  const legacyDir = language === "csharp"
    ? join(homedir(), ".local", "share", "vslsp", "code-mapper")
    : null;

  let removed = false;
  if (existsSync(installDir)) {
    rmSync(installDir, { recursive: true, force: true });
    console.log(`Removed: ${installDir}`);
    removed = true;
  }
  if (legacyDir && existsSync(legacyDir)) {
    rmSync(legacyDir, { recursive: true, force: true });
    console.log(`Removed legacy: ${legacyDir}`);
    removed = true;
  }
  if (!removed) {
    console.log(`${language} mapper is not installed.`);
  }
}
```

**Imports to add** (`vslsp.ts` top):
- Add `rmSync` to existing fs import (already has `existsSync`, `mkdirSync`)
- Add `homedir` from `os` if not already imported (check: `installDir` in registry may already be absolute)

> **Check first**: Read `src/code-mapping/registry.ts` to confirm whether `installDir` is already an absolute path (via `homedir()` or `DEFAULT_VSLSP`). If it is, no extra import needed.

**Step 4 — Command dispatch** (in the main switch, around line 355)
```typescript
case "uninstall-mapper": {
  if (!args.installLang) {
    error("Usage: vslsp uninstall-mapper <lang>  (csharp | rust | typescript)");
  }
  await uninstallMapper(args.installLang);
  break;
}
```

**Step 5 — Help text** (in the HELP string, around line 15)
Add to COMMANDS section:
```
  uninstall-mapper <lang>    Remove an installed mapper binary (csharp | rust | typescript)
```
Add to EXAMPLES section:
```
  vslsp uninstall-mapper rust
```

---

## Deliverable 3: `http.test.ts` Rewrite

### File to replace
`tests/http.test.ts` — full rewrite, same file location

### Approach: real HTTP server with mocked dependencies

The `createHttpServer()` function in `src/diagnostics/http.ts` accepts `{ port, client, store, solutionPath }`. For tests:
- Use a free port (e.g. 7860 or find-free-port)
- Mock `client` with a minimal object implementing only the methods http.ts calls (`didSave`, `didChange`)
- Mock `store` with a minimal object implementing `getAll()`, `getByFile()`, `getSummary()`
- Start server in `beforeAll`, stop in `afterAll`

### Test structure

```
describe("HTTP server — real behavior", () => {
  // beforeAll: start server on a free port with mocks
  // afterAll: call /stop or server.stop()

  describe("GET /health", () => { ... })
  describe("GET /status", () => { ... })
  describe("GET /diagnostics", () => { ... })
  describe("GET /diagnostics/summary", () => { ... })
  describe("POST /file-changed", () => { ... })
  describe("POST /file-content", () => { ... })
  describe("POST /stop", () => { ... })  // last — shuts server down
  describe("unknown routes", () => { ... })
})
```

### Key test cases (each route: ≥1 success + ≥1 error/edge case)

| Route | Success case | Error/edge case |
|-------|-------------|-----------------|
| GET /health | 200, `{status:"ok", pid:N}` | — |
| GET /status | 200, has `solution`, `ready`, `updateCount` | — |
| GET /diagnostics | 200, has `files[]` | `?file=` filters correctly |
| GET /diagnostics/summary | 200, has `errors`, `warnings`, `info`, `hints` | — |
| POST /file-changed | 200, `{ok:true, action:"didSave", path}` | missing path/uri → 400; nonexistent file → 404; `file://` URI normalized |
| POST /file-content | 200, `{ok:true, action:"didChange", path}` | missing content → 400; non-string content → 400 |
| POST /stop | 200, `{ok:true, message:"Daemon stopping"}` | — |
| Unknown | 404, `{error:"Not found"}` | — |
| Error resilience | After bad JSON body → 500, server still serves /health | — |

### AX-aligned test: localhost only
Instead of source-text matching, assert the server `hostname` config:
```typescript
test("server binds to 127.0.0.1 only", () => {
  expect(serverConfig.hostname).toBe("127.0.0.1");
});
```

### Security tests to keep (rewritten as behavior, not string match)
- Localhost binding: verify real `fetch()` to `http://0.0.0.0:PORT/health` fails or is refused
- No CORS headers: check real response headers don't include `Access-Control-Allow-Origin`

---

## Verification

```bash
# TypeScript clean
bun run tsc --noEmit

# All tests pass
bun test --timeout 60000

# CLI smoke test
vslsp --help | grep uninstall-mapper
vslsp uninstall-mapper rust       # "not installed" or removes binary
vslsp uninstall-mapper unknown    # exits 1 with supported langs message

# AX doc exists and is readable
cat docs/AX.md
```

---

## Merge Strategy

After all three agents complete:
1. Review diffs from each worktree
2. Merge W1 (docs) first — no conflicts possible
3. Merge W2 (CLI) — single file, no conflicts expected
4. Merge W3 (tests) — single file, no conflicts expected
5. Run `bun run tsc --noEmit` and `bun test --timeout 60000` on merged result
6. Tag v1.6.0

---

## Open Questions (resolve before executing)

1. Does `registry.ts` expose absolute paths for `installDir`? If so, `homedir()` import is not needed in `uninstallMapper`. **Read `src/code-mapping/registry.ts` at execution time to confirm.**
2. Does `createHttpServer()` return the server instance (needed for `afterAll`)? **Read `src/diagnostics/http.ts:15-25` to confirm.** If not, the stop route (`POST /stop`) serves as teardown — test it last.
3. Port for HTTP tests: use a fixed test-only port (e.g. `7860`) or find a free port dynamically? Prefer fixed to avoid flakiness, but check it doesn't conflict with daemon default (`7850`).
