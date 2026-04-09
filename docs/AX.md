# vslsp AX Constitution

## The AX Guarantee

A vslsp tool call must never return enough data to meaningfully pollute an agent's context window. This is the foundational contract of every tool in the vslsp MCP server. AI agents operate within finite context windows — typically 128K-200K tokens — and a single unfiltered tool response on a real codebase can easily produce 3-5MB of JSON. That one call consumes the entire window, leaving no room for the agent's reasoning, conversation history, or subsequent tool calls. vslsp treats context window preservation as a first-class design constraint: every tool response is filtered, budgeted, and — as a last resort — auto-truncated to ensure the agent remains functional after calling it.

## Budget Thresholds

| Filter combination | Budget | Rationale |
|---|---|---|
| `depth: "types"` | < 30KB | Type names only — should be tiny |
| `depth: "signatures"` | < 200KB | Types + method signatures — usable for an overview call |
| `file_filter` + `max_files: 5` | < 50KB | Focused subtree |
| `severity: "error", limit: 20` | < 10KB | 20 errors fits comfortably in a response |
| `depth: "full"` (opt-in) | > 200KB | Never appropriate for directory calls — use only for single files |

AX_BUDGET_BYTES = 200,000 bytes (see mcp.ts). Responses exceeding this are auto-truncated with a warning.

## Design Principles

### 1. Filter by default, not by exception

Filtering is the normal path. The default behavior without filters must warn, not silently return gigabytes.

### 2. Agent-actionable warnings

Warnings must tell the agent what to do next, not just what went wrong. Bad: "Response truncated." Good: "Response truncated from 312 to 45 files to fit context window budget (200KB). Use file_filter (e.g. "src/**") or max_files to scope results."

### 3. Tool schema describes the filtering surface

Tool parameter descriptions must include the AX implication. Example: the `depth` parameter description should mention that omitting it returns the full tree which may exceed the context budget.

### 4. Never silently return 0 files

If a filter produces 0 results, include a warning field explaining why and what to try instead.

### 5. Ratchet tests lock every contract in CI

Every budget threshold is a CI test. Tests fail if output is too large (upper bound) AND if output is empty (lower bound). New tools must ship with corresponding AX contract tests before merging.

## Tool Schema Standards

Parameter descriptions should follow this pattern:
- State what the parameter does
- Include the AX implication if relevant
- Example: `file_filter` — "Glob pattern to scope results (e.g. 'src/**'). Without this, large codebases may exceed the context window budget."

Error and warning messages must include the corrective action:
- Template: "[What happened]. [What the agent should do]. Example: [concrete example]."

## Error Message Standard

All error and warning messages in tool responses must be agent-actionable. This means:
1. State what happened (factual)
2. State what to do next (directive)
3. Give a concrete example where helpful

Example (good): "Response truncated from 312 to 45 files to fit context window budget (200KB). Use file_filter (e.g. \"src/**\") or max_files to scope results."
Example (bad): "Response too large."

## CI Enforcement

AX contracts are enforced by a dual-bound ratchet in `tests/e2e/mcp-server.test.ts`:
- **Lower bound**: filtered output must contain real data (filter didn't break and return empty)
- **Upper bound**: filtered output must be within the budget threshold

Tests A1-A6 cover `get_code_structure` filtering. Tests B1-B4 cover `get_diagnostics` filtering.

If a change makes a test fail its upper bound, that change is a context window regression and must not merge.

## Extension Checklist

When adding a new tool or language support, verify:
- [ ] Tool parameter descriptions mention AX implications for any parameter that affects output size
- [ ] Auto-truncation or filtering is implemented before returning large outputs
- [ ] Warning messages follow the agent-actionable standard above
- [ ] At least one AX contract test is added: upper bound (too large fails) + lower bound (not empty)
- [ ] Budget threshold for the new tool is documented here in the Budget Thresholds table
