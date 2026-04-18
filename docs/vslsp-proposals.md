# vslsp Improvement Proposals

Derived from direct agent feedback during integration test debugging (April 2026).
An Engineer subagent used vslsp as its primary tool while diagnosing a YubiOTP HID
timeout bug and reported honestly on where it helped and where it didn't.

---

## What Works Well Today

`verify_changes` + `get_diagnostics` is genuinely excellent. The pre-write dry-run
compile check is something bash + grep cannot replicate — it catches type errors before
a file is written to disk, eliminating the "edit → broken build → fix → re-edit" loop.

`get_code_structure` is useful for orientation on unfamiliar modules: file list, type
names, interface hierarchy.

---

## Gap 1 — `get_code_structure` drops all members for `internal sealed class`

### What happened

The Engineer called `get_code_structure` on `src/Core/src/Hid/Otp/`. It returned 6
types but **0 methods** for `OtpHidProtocol`. The method `WaitForReadyToReadAsync` —
the center of the entire bug — was invisible.

### Why it happens

The Roslyn mapper filters to `public` visibility by default. This is correct for
API surface documentation but wrong for debugging implementation code.

### Proposed fix

Add a `visibility` parameter:

- `"public"` — current behavior, default
- `"all"` — includes `internal`, `private`, `protected` members

```json
mcp__vslsp__get_code_structure({
  "path": "/abs/path/src/Core/src/Hid/Otp/",
  "language": "csharp",
  "depth": "signatures",
  "visibility": "all"
})
```

This is a mapper-level change only. The LSP daemon does not need to be involved.

---

## Gap 2 — No `find_symbol` (workspace symbol search)

### What happened

The Engineer knew the method name `WaitForReadyToReadAsync` but not which file it
lived in. They had to grep across `src/` and then `Read` the file to find the line.

The LSP daemon (once running) supports `workspace/symbol` — it can return file path
and line for any named symbol in the solution in ~50ms.

### Proposed new tool: `find_symbol`

```json
// Input
mcp__vslsp__find_symbol({
  "solution": "/abs/path/Yubico.YubiKit.sln",
  "query": "WaitForReadyToReadAsync",
  "kind": "method"    // optional: method | class | interface | field | property | all
})

// Output
{
  "symbols": [
    {
      "name": "WaitForReadyToReadAsync",
      "kind": "method",
      "file": "/abs/path/src/Core/src/Hid/Otp/OtpHidProtocol.cs",
      "line": 151,
      "signature": "private async Task<(ReadOnlyMemory<byte>, bool)> WaitForReadyToReadAsync(int, CancellationToken)"
    }
  ]
}
```

**LSP backing:** `workspace/symbol` — already implemented in OmniSharp, zero new
infrastructure needed.

---

## Gap 3 — No `find_usages` (find references / call chain tracing)

### What happened

After finding `WaitForReadyToReadAsync`, the Engineer needed to know who calls it.
They ran `grep -rn "WaitForReadyToReadAsync" src/`, then again for the callers of
those callers. Tracing the call chain `WriteUpdateAsync → SendAndReceiveAsync →
WaitForReadyToReadAsync` required three separate grep invocations.

This is the most common navigation pattern in any debugging session — "show me the
call chain" — and it is exactly what `textDocument/references` in LSP is designed for.

### Proposed new tool: `find_usages`

```json
// Input — by symbol name (convenience) or by file+line (precise)
mcp__vslsp__find_usages({
  "solution": "/abs/path/Yubico.YubiKit.sln",
  "symbol": "WaitForReadyToReadAsync"
  // OR — precise form:
  // "file": "/abs/path/src/Core/src/Hid/Otp/OtpHidProtocol.cs",
  // "line": 151,
  // "column": 52
})

// Output
{
  "definition": {
    "file": "/abs/path/src/Core/src/Hid/Otp/OtpHidProtocol.cs",
    "line": 151
  },
  "usages": [
    {
      "file": "/abs/path/src/Core/src/Hid/Otp/OtpHidProtocol.cs",
      "line": 132,
      "context": "var (firstReport, hasData) = await WaitForReadyToReadAsync(programmingSequence, cancellationToken)"
    }
  ],
  "count": 1
}
```

**LSP backing:** `textDocument/references` — standard LSP, OmniSharp supports this.
This single change would have cut the Engineer's grep work by ~60%.

---

## Gap 4 — No semantic subtree search (lower priority)

The Engineer had no way to ask "which files in `src/YubiOtp/` are involved in
HMAC-SHA1?" — the diagnostics tools are error-focused, not exploration-focused.

This gap is **partially addressed** by chaining `find_symbol` + `find_usages`.
A dedicated `search_code` tool (semantic grep within a file filter) would cover the
rest, but it is lower priority than the navigation gaps above.

---

## What vslsp Cannot and Should Not Try to Do

The Engineer's feedback correctly identified that runtime behavior is out of scope.

| Problem | Why vslsp cannot help | Right tool |
|---------|----------------------|------------|
| "Does the timeout fire in 1023ms or 1027ms?" | Static analysis has no concept of time | Hardware testing |
| "Does HMAC-SHA1 take longer than HOTP on flash?" | Firmware behavior, not code | Protocol analyzer / runtime logs |
| "Is SW=0x6985 caused by a missing slot flag?" | Requires knowing device state | Read + docs + hardware test |
| "Does HID OTP caching affect feature reports on macOS?" | OS-level runtime behavior | Runtime trace |

Adding runtime analysis to vslsp would be a category error — it is a Roslyn/LSP
wrapper, not a debugger or emulator. The right response to "can't help with runtime
bugs" is not to try; it is to make **static navigation** so fast and precise that
reading the right code takes seconds rather than minutes.

---

## Priority Ranking

| Priority | Change | Effort | Impact |
|----------|--------|--------|--------|
| **P0** | Fix `get_code_structure` to expose internal members via `visibility: "all"` | Low — mapper filter change | Immediate: 0-method results go away |
| **P1** | Add `find_symbol` (workspace symbol search) | Medium — new MCP tool wrapping `workspace/symbol` | Jump to any symbol in <1s instead of grep + Read |
| **P2** | Add `find_usages` (find references) | Medium — new MCP tool wrapping `textDocument/references` | Call chain tracing without grep chaining |
| **P3** | Add `search_code` (semantic subtree search) | High — requires additional indexing | Lower priority; P1 + P2 cover most cases |

---

## Net Assessment

vslsp today is a **diagnostics tool** that has one structural browser. What agents
actually need during debugging is a **navigation layer**: *where is this symbol
defined?* and *who calls it?* Those two questions drive the majority of codebase
exploration, and both are answered by LSP protocol requests that OmniSharp already
handles — they just are not exposed yet.

The `visibility: "all"` fix for `get_code_structure` is a one-liner in the mapper —
high impact, minimal effort. `find_symbol` and `find_usages` require new MCP tool
definitions but the underlying LSP calls are standard.

The boundary to hold: vslsp should not try to become a runtime debugger. The feedback
"vslsp can't explain why a 1023ms timeout fires at 1027ms" is correct and expected.
Position vslsp as the tool that gets you to the *right line of code* fast; from there,
human reading or runtime traces take over.

---

*Source: Engineer subagent investigation of `OtpHidProtocol.WaitForReadyToReadAsync`
timeout bug, April 2026. 45 tool calls, 96k tokens, ~9 minutes.*

---

## Post-v1.8.0 Evaluation (April 2026)

User validation after deploying `find_symbol`, `find_usages`, and `visibility: "all"`.

### What shipped and works

| Test | Result |
|------|--------|
| Tool count | 10 tools (was 8) — `find_symbol` and `find_usages` added |
| `find_symbol` for `WaitForReadyToReadAsync` | Found in 1 call: `OtpHidProtocol.cs:151`, container `OtpHidProtocol` |
| `find_usages` for `WaitForReadyToReadAsync` | Definition (line 151) + 1 usage (line 132 in `ReadFrameJavaStyleAsync`) — exactly right |
| `get_code_structure` with `visibility: "all"` | **Parameter accepted but 0 methods returned** for `internal sealed class OtpHidProtocol` |

### Verdict

`find_symbol` and `find_usages` are excellent. The Engineer subagent that debugged
the HID timeout bug needed 3 grep calls to trace the call chain `WriteUpdateAsync →
SendAndReceiveAsync → WaitForReadyToReadAsync`. With the new tools, that's a single
`find_usages` call — definition + all callers in one response, with file paths and
line numbers. This is a meaningful improvement.

`visibility: "all"` on `get_code_structure` is **still broken**. The parameter is
accepted without error, but `OtpHidProtocol` still shows 0 methods at
`depth: "signatures"`. The Roslyn mapper is still filtering to public members even
when `visibility: "all"` is passed. The type itself shows up (it's `internal`), but
its methods (`WaitForReadyToReadAsync`, `SendFrameAsync`, `ReadFeatureReport`, etc.)
are all dropped.

### Impact assessment

The two new navigation tools cover the most painful gap from the debugging session.
The visibility fix remains open but is lower-impact now that `find_symbol` can locate
any method regardless of access modifier — the workaround is `find_symbol` + `Read`
instead of `get_code_structure`.

### Updated proposal status

| Proposal | Status |
|----------|--------|
| **P0**: `visibility: "all"` in `get_code_structure` | **Not yet working** — parameter accepted, members still filtered |
| **P1**: `find_symbol` | Shipped and working |
| **P2**: `find_usages` | Shipped and working |
| **P3**: `search_code` (semantic subtree) | Not implemented (low priority, as expected) |

### Root cause hypothesis for P0

The CSharpMapper binary was rebuilt during development and tested successfully
(14 methods default vs 25 methods with `--visibility all` on the same `Otp/`
directory). The issue may be that the MCP server's `mapper.ts` passthrough has
a condition that only sends `--visibility all` when `lang === "csharp"` — but
if `language` is omitted and auto-detection returns a different result, or the
`depth: "signatures"` filter strips children after the mapper returns them, the
parameter may not reach the binary. Needs investigation.
