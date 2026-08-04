# Deferred Breakpoint Misalignment — Full Analysis & Handoff

> **Purpose:** A detailed record for the next agent attempting to fix
> bun-dap's deferred-breakpoint line-misalignment bug. Covers the bug,
> root cause, the bun upstream approach, every fix attempt and why it
> failed, the empirical facts established, and the exact final state of
> the code. Written 2026-08-04.

## 1. Origin

The session started with a simple ask: write
`examples/buggy.ts`, a deliberately-wrong program for manual testing of
bun-dap. That fixture is done and shipped. While smoke-testing it
through the adapter, a real adapter bug surfaced — deferred
(pre-parse) line breakpoints land on the wrong TS line when the source
has a comment header. The user approved attempting a fix; after
extensive investigation the fix proved to hit fundamental JSC timing
races and was reverted. This document captures everything so the work
doesn't have to be rediscovered.

## 2. The bug

**Symptom:** Launch a program whose TS source has a multi-line comment
header (or any structure that makes the generated JS line layout
diverge from the TS line layout). Set a line breakpoint *before* the
script parses (the normal launch flow: `setBreakpoints` arrives while
the `--inspect-wait` gate is still closed). The pause lands on the
**wrong statement** — roughly N lines off, where N tracks the
TS↔generated divergence (comment count + Bun's own preamble/merges).

**Concrete repro (buggy.ts):**
- `examples/buggy.ts` has a 16-line header comment, then
  `function applyDiscount` with `return subtotal * rate;` at TS line 23.
- Launch, `setBreakpoints` line 23, `configurationDone`.
- The stop's top frame is `makeCounter` at TS line 44 — **21 lines off,
  in a different function.** `subtotal` is not in scope; `evaluate
  "subtotal.toFixed(2)"` → `ReferenceError`.

**What works:** A breakpoint set *after* a pause (the `stopOnEntry`
flow, or set after the first stop) lands correctly. The adapter's
own source-map math (`SourceMap.generatedLocation` /
`originalLocation`) is correct. Only the **deferred arm** is wrong.

**Confirmed independently:** Another AI agent hit the same bug and
reported the offset corresponds directly to the number of comment
lines at the top of the source file. (The user relayed this.)

**Generalized the same day:** the trigger is ANY TS↔generated
divergence at the target line, not just comment headers. A real
1040-line file with only a 6-line header mis-landed a line-779
breakpoint ~70 lines off (verified via its inline map: TS 779 ↔ gen
709). Divergence accumulates across the file from statement
merges/inlines. See §11.2.

## 3. Root cause

`src/adapter/adapter.ts` `setBreakpoints`, Path B (script not yet
parsed), arms the breakpoint via:

```ts
Debugger.setBreakpointByUrl({ url: absPath, lineNumber: bp.line - 1, ... })
```

**Bun/JSC resolves URL-keyed breakpoints against GENERATED JS
coordinates, not TS lines.** When the transpiled layout diverges from
the TS source, `bp.line - 1` (a TS line, treated as a generated line)
points at the wrong statement. The adapter's `onBreakpointResolved`
then marks it `verified:true` and emits a `breakpoint` changed event
at the *requested* line — so the client thinks the bp is verified at
line 23, but the engine pauses at the generated line 23's statement,
which maps back to TS 44.

The original adapter comment (Path B) claimed: "JSC/Bun natively
defers URL-keyed breakpoints until the module parses, then resolves
them through the script's source map." **This claim is false.** Bun
resolves against generated coordinates; it does NOT translate the
line through the source map.

### Why simple fixtures masked it

`test/fixtures/hello.ts` and the rect-demo used in earlier verification
have ~1:1 TS↔generated layouts (tiny/no comment headers), so
`bp.line - 1` happens to align. The bug only manifests when the
divergence is nonzero.

## 4. Empirical facts established (Bun 1.3.14, macOS arm64)

All verified by raw WebSocket probes against `bun --inspect-wait`.
Probe scripts were in `/tmp` (deleted; reconstruct from this doc if
needed).

1. **`--inspect-wait` gate:** the module does not parse or execute
   until `Inspector.initialized` is sent (the adapter does this in
   `configurationDone`). Before that, no `Debugger.scriptParsed` or
   `Debugger.breakpointResolved` events fire.

2. **Event ordering after gate release:** `scriptParsed` →
   `breakpointResolved` (for deferred bps) → module body executes.
   The body runs *immediately* after parse; the inspector does NOT
   wait for our async handlers to complete.

3. **`Debugger.breakpointResolved` payload:** carries
   `{ breakpointId, location: { scriptId, lineNumber (0-based),
   columnNumber (0-based) } }`. The adapter's original
   `onBreakpointResolved` ignored `location`.

4. **`setBreakpointByUrl` can return `locations: []` immediately yet
   the bp later resolves and hits.** Probed on hello.ts:
   `arm@{lineNumber:1, columnNumber:2}` →
   `{"breakpointId":"...:1:2","locations":[]}`, then a
   `breakpointResolved` event with `location:{lineNumber:1,
   columnNumber:2}`, then a `Debugger.paused` at that location.
   **Do NOT treat `result.locations.length === 0` as failure** — the
   bp is deferred-even-post-parse and resolves via
   `breakpointResolved`.

5. **Bun's runtime transpile** (for `bun run file.ts`, NOT `bun build`):
   - Strips comments and blank lines.
   - Merges consecutive `let` declarations
     (`let a = 0; let b = 1;` → one generated line).
   - Inlines unreassigned `const`s
     (`const a = 20; const total = add(a, b)` → `add(20, 22)`).
   - Emits an inline `//# sourceMappingURL=data:application/json;base64,...`
     trailer AND a `//# sourceURL=<abs path>` trailer.
   - The TS↔generated offset is **non-uniform** within a file because
     of the merges/inlines.
   - **No `// @bun` preamble** for plain files
     (`scriptParsed.url` = the absolute TS path; generated line 1 is
     the first statement, not a preamble). (Note: `bun build` output
     DOES add a `// @bun`/`// path` preamble, but the runtime
     transpile does not — they differ.)

6. **`Debugger.removeBreakpoint` for a URL-keyed bp is racy:** the
   module body can hit the bp before the remove RPC completes.

7. **`debugger;` statements do NOT pause** under Bun's inspector in
   this setup (probed: no `DebuggerStatement` paused event). The
   fixture originally included one; it was removed as dead weight.

8. **A line-0 URL-keyed bp resolves to the first *pausable* statement**
   (JSC snaps past function declarations to the first breakable
   statement inside the first function). For `offset.ts` (fixture),
   line 0 → gen 1 col 2 = `const sum` inside `add`. This hit
   *brakes the body* — pausing it before exit — which is the key to
   why the placeholder approach works for that file (see §6).

## 5. bun's upstream solution

Repo: `oven-sh/bun`, package
`packages/bun-debug-adapter-protocol/src/debugger/`. Files fetched to
`/tmp/bun-adapter.ts` and `/tmp/bun-sourcemap.ts` (deleted; re-fetch
from GitHub raw if needed — the API listing approach in §5.1 works).

### 5.1 The placeholder design (`adapter.ts`)

`#setBreakpointsByUrl` (≈ line 713): if the source is not yet loaded,
arm **one** placeholder breakpoint at `lineNumber: 0` for the URL,
and stash the real requests as "future breakpoints" keyed by the
placeholder's `breakpointId`. Return all as pending.

```ts
if (!source) {
  result = await this.send("Debugger.setBreakpointByUrl", { url, lineNumber: 0 });
  return requests.map(request => this.#addFutureBreakpoint({
    breakpointId: result.breakpointId, url, breakpoint: request,
  }));
}
```

`["Debugger.breakpointResolved"]` (≈ line 1318): if the resolved id
has future breakpoints, the source is now loaded — re-run
`#setBreakpointsByUrl` with the real requests (now the source exists
→ `#generatedLocation` maps TS→generated correctly), emit `changed`
events, then remove the placeholder.

`["Debugger.paused"]` (≈ line 1403): **if a hit's `breakpointId`
belongs to a future-breakpoint placeholder, send `Debugger.resume`
and return WITHOUT emitting a `stopped` event.** This is the swallow
that makes a premature placeholder hit harmless.

```ts
if (reason === "Breakpoint") {
  const { breakpointId } = data;
  const futureBreakpoints = this.#getFutureBreakpoints(breakpointId);
  if (futureBreakpoints.length) {
    this.send("Debugger.resume");
    return;   // no stopped event
  }
  ...
}
```

### 5.2 Synchronous source-map decode (`sourcemap.ts`)

`SourceMap(url)` decodes the `scriptParsed.sourceMapURL` data URI
**synchronously** (`Buffer.from(base64, "base64url")` + `JSON.parse` +
`new SourceMapConsumer`). **No `Debugger.getScriptSource` RPC.** This
is critical: the re-arm in `breakpointResolved` must complete before
the body runs, and an extra RPC round-trip would lose that race for
fast modules.

bun's `onScriptParsed` (≈ line 1260) does:
```ts
const sourceMap = SourceMap(sourceMapURL);   // synchronous
this.#addSource({ ..., sourceMap });
```

### 5.3 Coordinate convention (bun's `sourcemap.ts`)

`generatedLocation` returns `line: lineTo0BasedLine(gline)` —
**0-based generated line** (their `Location.line` is 0-based).
`originalLocation` returns 0-based too. The bun-dap adapter uses
1-based generated lines internally (`gen.line - 1` when arming) — a
difference to keep straight if comparing.

## 6. Fix attempts and why each failed

### Attempt A — Correct on `breakpointResolved` (re-arm + remove old)

Armed at `bp.line - 1` (original). In `onBreakpointResolved`, mapped
the resolved `location` back to a TS line via `originalLocation`; if
it ≠ `bp.line`, removed the old JSC bp and re-armed at
`generatedLocation(bp.line)`.

**Failed:** the `removeBreakpoint` RPC races execution. The old
(misaligned) bp hit at the wrong statement *before* the remove
completed. Even with `await removeBreakpoint` before `setBreakpoint`,
the body ran during the await. Observed: stop at the wrong line with
`hitBreakpointIds` mapping to the *new* id (because I'd deleted the
old id from `jscToDapKey` before the remove landed).

### Attempt B — Line-0 placeholder (ported from bun)

Armed a line-0 placeholder per source; on `breakpointResolved`,
re-armed real bps via `generatedLocation`, removed the placeholder;
swallowed placeholder hits in `onPaused`.

**Worked for `offset.ts`** (9-line header, `add`/`main`): the
placeholder at line 0 resolved to `const sum` inside `add`
(`add(1,2)`'s first statement), which **braked the body** (paused it)
long enough for the re-arm at `return sum` (gen 3) to land. After the
swallow+resume, `add` continued and the corrected bp at `return sum`
hit → stop at the requested TS line 13. ✅

**Failed for `hello.ts` and `stepIn`:** hello.ts's placeholder at
line 0 and the real bp at line 2 (`const greeting`) **resolve to the
same/overlapping statement.** The placeholder hits, the swallow
resumes past it, `greet('World')` has already run, and the corrected
bp never gets a hit → no `stopped` event → the test times out.

Changing the swallow from `hitIds.some(placeholder)` to
`hitIds.every(placeholder)` (so a pause with both a placeholder id
and a real-bp id is NOT swallowed) did **not** fix it: the re-arm's
`setBreakpointByUrl` returns `locations: []`, the adapter set
`verified = locations.length > 0` → false, emitted `verified:false`,
and the later `breakpointResolved` for the re-armed id never
surfaced a `verified:true` (the process exited first for hello.ts).
The stop was still lost.

Additional sub-issues discovered while porting the placeholder:
- The original `onScriptParsed` loaded the map via
  `getScriptSource` (an RPC) → fast modules (hello.ts) exited during
  that await → re-arm failed with "closed". Fixed by decoding
  `sourceMapURL` synchronously (matching bun). This helped but did
  not resolve the overlap problem above.
- For `NoopSourceMap` files (no inline map), passing
  `columnNumber: 0` (from `generatedLocation`'s identity column 1
  → `columnNumber: 0`) pointed at leading whitespace on indented
  lines → `locations: []`. Fixed by omitting `columnNumber` when the
  map is a `NoopSourceMap`. (hello.ts actually has a real map, so
  this wasn't the hello blocker, but it would break no-map files.)

### Attempt C — Hybrid (arm `bp.line-1` + correct on resolve + stale-id swallow)

Armed at `bp.line - 1` (restores all original tests for
aligned/fast files). On `breakpointResolved`, if the resolved
original line ≠ requested, re-armed at `generatedLocation` and
marked the old JSC id **stale** (added to a `staleJscIds` Set,
deleted from `jscToDapKey`) — *without* removing it (removal races).
In `onPaused`, if every hit id is stale, `Debugger.resume` + no
stopped event.

**Restored 25/26 tests** (only the new offset regression failed).
But **failed for offset.ts and hello.ts line 7 (stepIn):** the
corrected bp at the target line (e.g. `return sum` gen 3, or
`greet('World')`) executes **during the async correction RPC**
(re-arm is ~1 RPC ≈ 200-500µs; the body starts in ~50µs). The
corrected bp isn't armed yet when the target runs → missed. The
stale (misaligned) bp then hits later → swallowed → no stop at all.
The stop is lost for any case where the target line executes within
the correction window.

The stale-marking was made synchronous (before the async re-arm) so
the swallow would catch a stale hit during the re-arm — but that
just guaranteed the stale hit is swallowed; the *correct* stop was
already missed.

### Why all attempts race

The fundamental issue: **for the misaligned case, you cannot arm the
correctly-placed bp before the body runs**, because the correct
location is only known post-parse (from the source map), and the
body runs immediately after parse — before any post-parse re-arm RPC
completes. The placeholder design *almost* solves this (its early
hit brakes the body), but fails when the placeholder's resolved
statement coincides with or runs past the real bp's target.

## 7. Final state of the code (as of this writing)

**The adapter is reverted to its original behavior.** All 25 original
tests pass; the suite is green. The bug is documented, not fixed.

### `src/adapter/adapter.ts` — original behavior

- `setBreakpoints` Path A (source parsed, real `SourceMap`): arms at
  `generatedLocation(bp.line, 0)` via `setBreakpointByUrl` with
  `columnNumber: gen.column - 1`. Correct.
- `setBreakpoints` Path B (source not parsed): arms at
  `lineNumber: bp.line - 1` via `setBreakpointByUrl`. **This is the
  bug** — Bun treats it as a generated coordinate.
- `onScriptParsed`: async, fetches `getScriptSource`, decodes
  `sourceMapURL` via `SourceMap.fromSourceMapURL` or
  `SourceMap.fromSourceText`, sets `entry.sourceMap`. (Original —
  uses the RPC, not synchronous decode.)
- `onBreakpointResolved`: sync, `{ breakpointId }` only, marks
  `verified:true` + emits `changed`. Does NOT inspect `location`.
- `onPaused`: no placeholder/stale swallow. Hit-count gating, then
  condition gating (line + function bps, `evalCondition(condition,
  topFrame)`), then logpoint handling, then `emitStopped`.
- No `placeholders` field, no `staleJscIds`, no `BreakpointResolvedEvent`
  interface, no `Location` import, no `mapReady` on `SourceEntry`,
  no `armPendingBreakpoints` method.

### `examples/buggy.ts` — new (the original ask)

Deliberately-wrong program for manual testing. 4 buggy functions
(applyDiscount, computeAverage, fibonacci off-by-one, sign-flipped
makeCounter), 4 console.logs of wrong numbers, intentional `throw`
at end (exit code 1). Header comment documents what to exercise AND
truthfully warns about the deferred-breakpoint bug (a bp set before
load lands ~21 lines off; a bp set after a pause lands correctly).

### `test/fixtures/offset.ts` — new (minimal repro)

9-line comment header + `function add` + `function main` + `main()`.
Designed so that a deferred bp at TS line 13 (`return sum`) mis-resolves
to a different statement. Runtime generated layout (verified):
```
 1: function add(left, right) {
 2:   const sum = left + right;
 3:   return sum;
 4: }
 5: function main() {
 6:   const first = add(1, 2);
 7:   const second = add(3, 4);
 8:   const total = first + second;
 9:   console.log(`total: ${total}`);
10:   console.log(`total*2: ${total * 2}`);
11:   console.log(`again: ${total}`);
12:   console.log(`final: ${total}`);
13: }
14: main();
```
Source map: `gen(TS 11) -> {line:1, column:1}`,
`gen(TS 12) -> {line:2, column:3}`, `gen(TS 13) -> {line:3, column:3}`,
`orig(gen 11,0) -> line 22`, `orig(gen 12,0) -> line 23`.
So armed `bp.line-1 = 12` → resolves gen 13 = `main()`... actually
empirically resolves to gen 12 (`console.log("final")`, TS 23).
The exact snap target varies; the point is it's ≠ TS 13.

### `test/adapter.test.ts` — `test.skip` documenting the bug

A skipped test (`test.skip(...)`) at line ~169 that asserts a
deferred bp at offset.ts line 13 stops at line 13. The skip comment
contains the full bug analysis (root cause, both fix approaches and
why they race, pointer to bun's adapter). `offset` fixture path
added as a const near the top; `offsetFixture` also exported from
`test/util/dap-helpers.ts` (unused by the skip, kept for the next
attempt).

### `test/util/dap-helpers.ts`

Added `export const offsetFixture = resolve(repoRoot, 'test/fixtures/offset.ts');`
(one line). Everything else unchanged.

### Verification

- `bunx tsc --noEmit`: clean.
- `bun test`: **25 pass, 1 skip, 0 fail**.
- `bun run examples/buggy.ts`: prints wrong numbers, exits code 1.

## 8. Recommendations for the next attempt

### 8.1 The likely-correct approach: pause the VM across the correction

The race is "body runs during the re-arm RPC." The clean fix is to
**prevent the body from running until the correctly-placed bp is
armed.** Options to explore:

- **`Debugger.setBreakpointsActive { active: false }`** at the start
  of the correction, re-enable after the re-arm lands. Caveat: while
  inactive, the target line could execute unimpeded — so this only
  works if the correction completes before the target runs, which
  isn't guaranteed for early targets. May need to combine with the
  placeholder's braking hit.
- **`Debugger.pause`** immediately after gate release, do all
  arming while paused, then `Debugger.resume`. This is essentially
  "always stopOnEntry briefly." Heavy-handed but race-free. Check
  whether JSC allows `pause` while not yet running and whether
  `resume` then runs the body.
- **The placeholder + a non-overlapping brake:** the placeholder
  works when its resolved statement is *different from* and *earlier
  than* the real bp's target. The failure is when they coincide
  (hello.ts). Could the placeholder be armed at a line that resolves
  to a statement guaranteed *before* any requested bp target but
  *not* a target itself? Line 0 resolves to the first pausable
  statement — which IS often a target (hello line 2). Hard to
  guarantee in general.

### 8.2 Investigate why `setBreakpointByUrl` returns `locations: []` post-parse

For hello.ts, `setBreakpointByUrl {lineNumber:1, columnNumber:2}`
post-parse returned `locations: []` yet the bp later resolved and
hit. bun's adapter re-arms via the same call and presumably gets
the same `[]` — but it doesn't gate `verified` on
`locations.length > 0`; it waits for `breakpointResolved`. **The
bun-dap adapter should NOT set `verified = locations.length > 0`
for the re-arm** — it should emit `verified:false` initially and let
the subsequent `breakpointResolved` for the new id flip it to true
(the existing "directly-armed" branch in `onBreakpointResolved`
does exactly this). This was a latent bug in my placeholder port.

### 8.3 Match bun's synchronous map decode

`onScriptParsed` should decode `scriptParsed.sourceMapURL`
synchronously (no `getScriptSource` RPC), falling back to
`NoopSourceMap` when absent. This removes one RPC from the re-arm
critical path. (Keep `getScriptSource` for the DAP `source`
request.) I implemented this in a reverted attempt; it's a
standalone improvement worth keeping regardless of the fix.

### 8.4 The hello.ts overlap is the crux

Any placeholder-based fix MUST handle the case where the
placeholder's resolved statement is the same as (or executes after
a target that runs before) the real bp's target. bun's adapter
appears to handle this — study whether bun's `#setBreakpointsByUrl`
re-arm path, when the source is already loaded by the time
`breakpointResolved` fires, arms at the right place AND whether
bun's swallow (`every` vs `some`, and the exact `data.breakpointId`
semantics) differs. Re-fetch `/tmp/bun-adapter.ts` and read
`["Debugger.paused"]` (≈ line 1371) and `#setBreakpointsByUrl`
(≈ line 713) carefully.

### 8.5 Tests to keep green

The full suite must stay at 25 pass / 1 skip. The tests that broke
during attempts, in priority order:
1. `e2e: launch hello.ts` (adapter.test.ts) — line 2 bp, fast module.
2. `stepping: stepIn ...` (adapter-control.test.ts) — line 7 bp,
   which is ALSO misaligned (TS 7 `greet('World')` → gen 6, armed 6
   → resolves gen 7 = `console.log('done')` TS 9).
3. `conditional breakpoint` / `hitCondition` / `logpoint` — exercise
   the condition/hit/log gating in `onPaused`; any swallow added
   there must not eat these.
4. `attach` / `symlinked program path` / `transport` — attach and
   path-canonicalization flows.

### 8.6 Process note

**Commit before starting.** This repo had no commits when I began,
so when the adapter edits broke the suite there was no `git restore`
— I had to reconstruct the original by hand from transcript read
outputs. Make a checkpoint commit first.

## 9. Key files to read

- `src/adapter/adapter.ts` — `setBreakpoints` (≈ line 445),
  `onScriptParsed` (≈ line 401), `onBreakpointResolved` (≈ line 431),
  `onPaused` (≈ line 702), `emitStopped` (≈ line 856). The bug is
  Path B of `setBreakpoints`.
- `src/sourcemap.ts` — `SourceMap.generatedLocation` (line 73),
  `originalLocation` (line 87), `NoopSourceMap` (line 103).
- `test/adapter.test.ts` — the `test.skip` at ≈ line 169 (bug
  analysis); `launchReady`/`armBreakpoint`/`breakpointVerified`
  helpers at lines 40-86.
- `test/fixtures/offset.ts` — the minimal repro.
- `examples/buggy.ts` — the manual-test fixture + the original ask.
- `examples/agent-usage.md` — the wire protocol (notes the
  deferred-breakpoint `verified:false` → `changed` flow).
- bun upstream: `packages/bun-debug-adapter-protocol/src/debugger/adapter.ts`
  and `sourcemap.ts` in `oven-sh/bun` (GitHub raw URLs; the
  `api.github.com/repos/oven-sh/bun/contents/...` endpoint lists
  paths).

## 10. Managed skill & memory

A managed skill `bun-dap-deferred-breakpoint-bug` and a long-term
memory entry were created with the empirical facts and race
analysis. Future sessions on this repo should surface them via
`recall`/skill discovery.

## 11. Follow-up session (2026-08-04): real-file reproduction, generalization, validated fix direction

> Added by a second session that independently hit the same bug while
> debugging a REAL program through bun-dap (permissions-ctrl/test.ts)
> and then proved the fix direction with raw-JSC probes. Complements
> §2–§8; corrects the "offset ≈ comment lines" scoping.

### 11.1 What was analyzed

Real-file debug session: `permissions-ctrl/test.ts` (1040 lines), set
a breakpoint at TS line 779, step line-by-line to 783
(`const got = engine.decide(cmd, cwd);`), step into `engine.decide`
(a class method defined in `src/engine.ts`, another module). The user
reports this exact flow works in VSCode; the goal was to find why
bun-dap diverges.

### 11.2 Result: same root cause, generalized trigger

- bp@779 → the stop's top frame mapped to TS **871** (92 lines off,
  inside a different loop). Identical Path B behavior to §2.
- `test.ts` has only a **6-line** comment header, yet the mislanding
  at line 779 was ~70 lines. Direct inline-map verification: TS 779
  ↔ gen 709 (offset 70 at that line). The offset is **not** the
  comment count — it accumulates across the file from transpile
  statement merges/inlines (a 700-line `TEST_CASES` literal makes the
  generated layout drift). Comment headers are one cause; large or
  merge-heavy files are another. §2's "offset ≈ comment lines" was
  the small-file special case.

### 11.3 New empirical facts (raw JSC probes, Bun 1.3.14)

1. **No `scriptParsed` (and no `breakpointResolved`) before
   `Inspector.initialized`** — confirms §4.1. Corollary: in launch
   mode, Path B's arm ALWAYS happens pre-parse; the correctly-mapped
   Path A is dead code in the normal flow.
2. **Deferred arms with the correct generated coordinates resolve
   exactly.** `setBreakpointByUrl {lineNumber: 708, columnNumber: 6}`
   pre-parse → `breakpointResolved (708,6)` → paused `(708,6)` →
   backward-map → TS 779. JSC defers precisely; the ONLY error is the
   adapter feeding a TS line where a generated line belongs (§3).
3. **Column-0 continuation artifact:** every generated line carries a
   col-0 segment that backward-maps to the PREVIOUS statement's tail
   (`originalPositionFor(709, 0, GLB)` → TS 778:37;
   `originalPositionFor(709, 6, GLB)` → TS 779:12). `originalLocation`
   must use the frame's real column (it does); column-0 lookups are
   off by one statement. Any fix must not re-derive lines via col-0
   queries.
4. **Query flavor difference:** upstream's `generatedPositionFor(779,
   col 0)` returns gen **709:0**; our min-column scan returns
   **709:6**. Both snap to the same statement when armed; irrelevant
   to the bug but useful when comparing against upstream.
5. `locations: []` in the set response for a deferred arm is not a
   failure (§4.4 reproduced: set → `locations: []`, then resolved +
   hit).
6. **stepInto matrix (separate investigation, raw JSC):** `stepInto`
   ENTERS cross-module calls (plain functions AND class methods);
   skips same-module calls (plain, methods, object-literal methods).
   `engine.decide` (class method in another module) IS entered —
   verified end-to-end on the real file: bp 779 → next×4 → 783 →
   stepInto → paused inside `decide` (`[decide < runSelfTest <
   module]`). So once the bp lands correctly, the user's VSCode flow
   works in bun-dap with NO stepping changes — no synthetic stepping
   needed.

### 11.4 A validated fix direction (probe-proven on the real file)

§8.1 guessed "pause the VM across the correction". A raw probe
(`probe-full-flow.ts`, scratch in /tmp) ran exactly that and it
works:

1. Path B: arm ONE line-0 placeholder per source (upstream's design,
   §5.1).
2. Gate release → `scriptParsed` → placeholder resolves → the VM
   **pauses at the first pausable statement**, BEFORE any requested
   target can execute (the first pausable statement precedes every
   target by construction).
3. While paused: decode the map (an RPC is now race-free — the VM is
   stopped; sync decode per §8.3 remains a nice-to-have, not a
   correctness requirement), arm all pending bps at their generated
   locations, remove the placeholder.
4. `Debugger.resume`. Verified on test.ts: correct stop at 779,
   stepping 779→783, stepInto entered `decide`.

**Why this beats §6 Attempt B:** Attempt B swallowed the placeholder
hit and resumed BEFORE re-arming (re-arm on `breakpointResolved`,
racing the body). The design above keeps the VM paused through the
re-arm — the pause IS the brake; there is no window.

**The hello.ts overlap (§8.4) resolves cleanly here:** at
placeholder-pause time, check whether the placeholder's resolved
location equals any pending target's generated location (sync map
decode). If yes — the placeholder pause IS the correct stop for that
bp: emit `stopped` for it directly, no swallow, no re-arm. Only
swallow/resume when the placeholder location is not itself a target.
hello.ts's line-2 bp (placeholder gen 1:2 == target gen 1:2) becomes
a stop at line 2; the stepIn test's line-7 bp (target gen 6 ≠
placeholder gen 1:2) takes the normal re-arm path. The overlap-as-stop
logic is predicted correct by construction but NOT yet fixture-tested
(open item).

### 11.5 Status

No source changes made (analysis-only authorization). Suite still 25
pass / 1 skip. Ready to implement on approval: the §11.4 design + a
regression test using a REAL divergence fixture (a file with a large
merged body, bp far from module start, asserting the stop lands on
the requested TS line) + the cross-module stepInto test. Per §8.6:
commit before starting.
