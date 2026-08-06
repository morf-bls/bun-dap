# Repository Guidelines

A practical guide for AI assistants working in **bun-dap** — a standalone, IDE-agnostic
[Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) **server**
for [Bun](https://bun.sh/). It drives Bun's JavaScriptCore inspector (`--inspect` /
`--inspect-wait` / `--inspect-brk`) and exposes DAP over stdio or TCP so any client
(Neovim, Helix, the oh-my-pi harness, AI agents) can debug TypeScript/JavaScript running
on Bun. Independent community project; shares no code with Oven's `bun-debug-adapter-protocol`
or `bun-vscode`.

## Project Overview

bun-dap is the missing Bun debugger for everything outside VS Code. Bun ships no
published debug adapter — its official debugger lives inline in the VS Code extension
host with no spawnable server and no DAP wire transport. bun-dap fills that gap: a
publishable package + CLI that runs **on the Bun runtime**, built on Microsoft's
[`@vscode/debugadapter`](https://github.com/microsoft/vscode-debugadapter-node) framing,
with a from-scratch DAP⇄JSC translation layer.

The hard problem this project solves — and the one most edits touch — is **deferred
breakpoints**: breakpoints set on TypeScript lines *before the target script has parsed*
must be held pending, mapped through the inline source map the moment the script parses,
and armed at generated-JS coordinates before the module body runs. This machinery is
verified by an end-to-end suite that spawns real Bun children, not assumed to work.

## Architecture & Data Flow

```
src/cli.ts            transport entry (stdio single-session | TCP multi-session server)
   └─> src/session.ts       DAP session: protocol framing/dispatch (LoggingDebugSession),
                            capabilities, adapter→event bridge via AdapterHost
        └─> src/adapter/adapter.ts    the DAP⇄JSC engine (the heart, ~1785 lines)
             ├─> src/inspector/websocket-inspector.ts   typed JSC client over ws
             │     └─> src/inspector/jsc-types.ts       hand-written JSC protocol types
             │     └─> src/inspector/preview.ts         RemoteObject → display string
             ├─> src/sourcemap.ts          source-map-js wrapper (1/0-based discipline)
             └─> src/util/port.ts, src/util/loopback.ts
```

### Launch data flow

1. **Transport** (`cli.ts`): no args → stdio `DebugSession.run(BunDapSession)` (one session
   per process); `<port> [host]` → `net.createServer`, one `BunDapSession` per socket,
   `Content-Length` framing via `ProtocolServer.start`. Socket `close` → `terminateDebuggee`
   + `stop()` so dropped connections don't orphan debuggees.
2. **Session** (`session.ts`): client `launch` → `BunDapSession.launchRequest` →
   `getAdapter().launch(args)`. Adapter is lazy-constructed; `adapter.host = this.makeHost()`
   wires the `AdapterHost` callback seam (adapter calls `host.sendStopped`/`sendOutput`/…,
   knows nothing about `@vscode/debugadapter` events). Lines/columns start at 1
   (`setDebuggerLinesStartAt1(true)`).
3. **Launch** (`BunDebugAdapter.launch`): canonicalize program (`realpathSync` — Bun reports
   symlink-resolved URLs), spawn `bun --inspect-wait=127.0.0.1:<free-port> program`
   (always `--inspect-wait`; `--inspect-brk` adds no pause over the protocol — `stopOnEntry`
   is a deferred line-0 bp instead). `scrapeInspectorUrl` forwards pre-URL stderr as output,
   scrapes the `ws://` URL, then `forwardOutput` takes over. `new WebSocketInspector(url)` →
   `awaitConnected` → `attachInspector()`.
4. **`attachInspector`**: enable sequence (`Runtime.enable`, `Console.enable`,
   `Debugger.enable`, `Debugger.setAsyncStackTraceDepth`), registers inspector event handlers
   (`scriptParsed`/`paused`/`breakpointResolved`/`resumed` + `disconnected`→`onDebuggeeGone`),
   sends `host.sendInitialized()`, flushes `stoppedBuffer` (pre-initialized stops buffered).
5. **Breakpoints before parse** (`--inspect-wait` gate holds parsing until configDone):
   `setBreakpoints` canonicalizes via `realpathSync`, keys `line-<n>`, stores `LineBreakpoint`,
   registers in `pendingByPath` **synchronously before** the placeholder RPC awaits, and arms
   a **line-0 placeholder** via `Debugger.setBreakpointByUrl` (upstream Bun design; module-scoped
   engine brake). Placeholders tracked in `placeholdersById` + permanent `placeholderJscIds`.
6. **`configurationDone`** (releases the gate): if `pendingByPath.size > 0`, arms the one-shot
   **entry brake** — a pre-gate `Debugger.pause` (`brakePending=true` set *before* the await) —
   then `Debugger.setBreakpointsActive` + `Inspector.initialized`.
7. **`onScriptParsed`**: registers `SourceEntry {scriptId, path, sourceMap}`, decodes the map
   **synchronously** from `scriptParsed.sourceMapURL` (data-URI base64 decode — no
   `getScriptSource` RPC), and arms all deferred bps for that path at map-derived generated
   coords *while the VM is frozen by the brake*, so binds land before the body runs.
   `NoopSourceMap` fallback for unmapped scripts.
8. **`onPaused`** (single funnel for all pause kinds): stamps frame tables, resets `objectRefs`;
   brake-pause branch → placeholder branch (alias → the pause stands in for the bp hit) →
   hit-count gating → condition gating (`evalCondition` via `Debugger.evalCallFrame`;
   bigint/symbol truthiness recovery) → logpoints (always log + resume, never stop) →
   `mapStopReason()` → `emitStopped` (buffered until `initializedSent`).
9. **Teardown**: `terminateDebuggee` — SIGTERM child (SIGKILL after 3s); attach mode resolves
   `process.pid` over inspector and SIGTERMs (refused for non-loopback hosts). `onDebuggeeGone`
   dedupes exited+terminated.

### The hybrid brake design (central pattern — read before touching breakpoints)

JSC resolves URL-keyed breakpoints against **generated JS coordinates, never TS lines**, and
transpile divergence accumulates across a file, so arming at `bp.line - 1` lands on the wrong
statement. The fix is a two-part brake:

- **Global brake** (`configurationDone`, `Debugger.pause` pre-gate) covers import-free entries
  where the entry's first executed statement IS in the entry file.
- **Per-source line-0 placeholder** (Path B): arms `setBreakpointByUrl(url, 0)` for each
  not-yet-parsed source. JSC resolves it to the source's first pausable statement and pauses
  there, holding the module body until the mapped arms bind. Covers entries with imports (whose
  first executed statement lives in a builtin initializer *before the entry module parses*).

Placeholder pitfalls (all probe-verified, all load-bearing — see `skill://bun-dap-deferred-breakpoint-bug`):
1. Register `pendingByPath` **synchronously before** the placeholder RPC await — a registration
   after the await is never flushed when `scriptParsed` races the in-flight placeholder.
2. **Alias case**: placeholder resolved location == bp's mapped target → do NOT remove the
   placeholder (shares coords with the real bp; `removeBreakpoint` disarms both). Record
   `placeholderAlias`; the placeholder's pause IS the hit.
3. **Entry-bp reuse**: `stopOnEntry` + Path B on the entry file → JSC rejects the second
   same-location bp; `configurationDone` reuses the placeholder's jsc id as `entryBreakpointId`.
4. Guard `onBreakpointResolved` removal with `record.jscId !== this.entryBreakpointId`.
5. Placeholder swallow must fall through when `stopOnEntry` is owed and the pause is in the
   entry file.
6. Late pauses after teardown are swallowed; `placeholderJscIds` is permanent.

## Key Directories

| Path | Purpose |
|---|---|
| `src/cli.ts` | stdio/TCP transport entry, arg parsing, `--help`, bind-host RCE warning |
| `src/session.ts` | DAP session: dispatch, client-capability advertising, `AdapterHost` bridge, capabilities, terminate |
| `src/adapter/adapter.ts` | **The DAP⇄JSC engine** — inspector ownership, breakpoint/state stores, pause/step/stack/variables/evaluate, launch/attach lifecycle. ~6× any other core file |
| `src/sourcemap.ts` | `source-map-js` wrapper; synchronous decode of Bun's base64 data-URI maps; 1-based-in/out discipline |
| `src/inspector/websocket-inspector.ts` | Typed JSC inspector client over `ws`: id-correlated request promises, event re-emission, pre-open frame queueing, 10s per-request timeout |
| `src/inspector/jsc-types.ts` | Hand-written minimal JSC protocol types — source of truth for `inspector.send(method, params)` |
| `src/inspector/preview.ts` | `RemoteObject` → display-string formatting |
| `src/util/port.ts` | OS-assigned free loopback port (`getAvailablePort`) |
| `src/util/loopback.ts` | Single source of truth for loopback-host detection (CLI bind warning + attach termination guard) |
| `test/` | Unit + e2e tests (spawns real Bun children) |
| `test/util/` | `mock-inspector.ts`, `framed-client.ts`, `dap-helpers.ts` — test harness |
| `test/fixtures/` | Minimal TS programs each exercising a specific debug shape |
| `examples/` | `nvim-dap.lua`, `dap.json`, `agent-usage.md`, `buggy.ts` |

## Development Commands

Runtime is **Bun** (not Node). Package manager is **bun** (`bun.lock`).

```sh
bun install                              # install deps
bun test                                 # full suite (spawns real bun children — slow)
bun test test/unit-adapter.test.ts       # single file
bun test -t "logpoint"                   # tests whose name contains "logpoint"
bun run typecheck                        # tsc --noEmit -p tsconfig.json
bun run build                            # bun build src/cli.ts --target=bun --outfile dist/bun-dap
bun run format                           # prettier --write . && eslint --quiet --fix --fix-type layout .
bun run lint                             # eslint . --max-warnings=0; tsc --noEmit
```

**`lint` caveat:** the script uses `;` not `&&`, so `tsc` runs even if eslint fails and the
exit code is tsc's. When iterating, run `eslint . --max-warnings=0` and `tsc --noEmit`
separately to catch both.

Running the server directly:
```sh
bun run src/cli.ts            # stdio DAP server (default)
bun run src/cli.ts 4711       # TCP DAP server on 127.0.0.1:4711
bun run src/cli.ts 4711 0.0.0.0   # non-loopback — UNAUTHENTICATED RCE surface, see warning
bun run src/cli.ts --help     # usage, flags, security notes
```

## Code Conventions & Common Patterns

### Formatting & naming
- **4-space indent**, single quotes, trailing comma (es5), semicolons, `printWidth: 120`
  (`.prettierrc`). Imports sorted by `@trivago/prettier-plugin-sort-imports` (blank line
  between groups, specifiers sorted).
- Files: kebab-case (`websocket-inspector.ts`). Dirs: `src/inspector/`, `src/adapter/`,
  `src/util/`. Exported symbols: PascalCase classes (`BunDebugAdapter`), `I`-less interfaces
  (`AdapterHost`, `LaunchArgs`), camelCase functions (`getAvailablePort`, `formatRemoteObject`).
  Private fields: `private` + camelCase.
- **`import type`** is required for type-only imports (`consistent-type-imports`,
  `fixStyle: 'inline-type-imports'`, applied by `format`).

### TypeScript strictness
- `strict`, **`noUncheckedIndexedAccess`** (indexing `T[]`/records yields `T | undefined` —
  narrow it), `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`,
  `skipLibCheck` (never fix third-party `.d.ts`), `allowJs: false` (everything is `.ts`),
  `types: ["bun"]` (Bun globals only — no Node types).
- `eslint.config.ts` and `examples/*.ts` are **outside** tsconfig's `include`; they're parsed
  via ESLint's `projectService.allowDefaultProject` so type-aware linting doesn't fail.

### Async patterns
- Session DAP handlers are `async (): Promise<void>` on `LoggingDebugSession`. The base-class
  dispatch **does not await** them (fire-and-forget), so they must never reject: every handler
  wraps in try/catch and answers with `sendErrorResponse`. This is why eslint has
  `no-misused-promises: ['error', { checksVoidReturn: false }]` — the SDK discards the promise
  (void context); flagging it would force artificial `void`/`catch` noise on every handler.
- `WebSocketInspector.send` returns `Promise<ResultOf<M>>` via `Promise.withResolvers`,
  rejected on JSC error / timeout / close. Adapter fire-and-forget sends use `.catch(() => undefined)`.
- The `Debugger.paused` handler is the one event handler that awaits and is allowed to reject;
  wrapped as `void this.onPaused(...).catch(diagnostic)` — errors → stderr, never stdout.

### Error handling
- **stdout is sacred** — carries only framed DAP messages. All diagnostics (`[bun-dap]` prefix)
  go to `stderr` via `diagnostic()`/`process.stderr.write`. This is load-bearing: AI agents
  parse `stdout` as pure DAP. SDK logging is disabled: `logger.setup(Logger.LogLevel.Stop, false)`.
- User-visible errors → DAP error responses with codes: `1001` launch/attach, `1002` eval,
  `1003` breakpoints, `1004` configDone, `1005` stackTrace, `1006` scopes/variables.
- Secrets (env, expressions, conditions) are never logged to the adapter's own stderr.
- Thrown errors carry actionable messages (program missing, attach url invalid, non-loopback
  termination refused).

### State management (mutable state in `BunDebugAdapter`)
- Script maps: `sources` (TS path→`SourceEntry`), `sourcesByScriptId` — both updated in `onScriptParsed`.
- Breakpoint stores: `lineBreakpoints` (`line-<n>`), `functionBreakpoints` (`fn-<n>`),
  `jscToDapKey` (jscId→key), `pendingByPath` (canonical path → deferred keys),
  `placeholdersById`, `placeholderJscIds` (permanent swallow set), `placeholderAlias` (one-shot),
  `entryBreakpointId`.
- Pause-state: `currentCallFrames`, `currentFrameIds`, `frameIdToCallFrame` — cleared by
  `clearPauseState()` (called eagerly by resume/step sends because JSC does **not** reliably emit
  `Debugger.resumed`); `objectRefs` `Handles` counter reset at each `onPaused` start (stale refs →
  `-32000`).
- Flags: `paused`, `stepPending`, `brakePending`, `firstPausePending`, `configDoneSent`,
  `initializedSent`, `debuggeeGoneSent`, `noDebug`, `stopOnEntry`, `exitCode`.

### Dependency injection / wiring
- `cli.ts` never imports the adapter — it starts `BunDapSession` only. Session owns the adapter
  via lazy `getAdapter()`; `adapter.host` is set after construction (the adapter calls `host`
  callbacks for events). Adapter constructs its `WebSocketInspector(url)` directly in
  `launch`/`attach` (no inspector DI in production). `AdapterHost` is the seam between the
  transport-agnostic engine and the `@vscode/debugadapter` session.

### Source-map line discipline (critical)
- **DAP is 1-based; JSC is 0-based.** Conversions live **only** in adapter arm functions and the
  map itself: `armLineBreakpoint` sends `lineNumber: gen.line - 1`, `columnNumber: gen.column - 1`;
  `stackTrace` converts JS frame locations back via `originalLocation(jsLine0, jsCol0)` → 1-based
  TS lines for the client.
- `SourceMap.generatedLocation(origLine1)` uses a **statement-start min-column scan** (GREATEST_LOWER_BOUND
  at col 0 fails for indented statements). `originalLocation` returns column 1 (consumer columns
  unreliable for TS→JS). `NoopSourceMap` is identity (1-based→(line,1)) for unmapped scripts.

### Probe-verified JSC facts (commented in source — respect them)
- JSC emits hit ids as either a `data.breakpoints` array OR a `data.breakpointId` string — both parsed.
- An arm can return `locations: []` yet resolve+hit later — never gate `verified` on locations alone.
- JSC does NOT reliably emit `Debugger.resumed` after `stepNext` → eager `clearPauseState()`.
- Bun/JSC 1.3.x **ignores** `condition` and `isAutoContinue` bp params → conditions are evaluated
  adapter-side (one pause+resume RPC per hit — keep conditional/logpoint bps out of hot loops).
- `--inspect-brk` never delivers an entry pause over the protocol.

## Important Files

- **Entry:** `src/cli.ts` (transport, `--help`), `src/session.ts` (`BunDapSession`)
- **Engine:** `src/adapter/adapter.ts` — `BunDebugAdapter`, `AdapterHost`, `LaunchArgs`/`AttachArgs`,
  `onPaused`, `onScriptParsed`, `configurationDone`, `setBreakpoints`, `armLineBreakpoint`,
  `mapStopReason`, `compileLogMessage` (exported; `${}` walk with brace-depth counter)
- **Sourcemap:** `src/sourcemap.ts` — `SourceMap`/`NoopSourceMap`, `generatedLocation`, `originalLocation`
- **Inspector:** `src/inspector/jsc-types.ts` (`DevRequestMap`, `DevRequest`, `ResultOf<M>`, `CallFrame`,
  `PausedEvent`, `Location`, `RemoteObject`), `websocket-inspector.ts` (`WebSocketInspector.send`/`onMessage`),
  `preview.ts` (`formatRemoteObject`)
- **Config:** `package.json`, `tsconfig.json`, `eslint.config.ts`, `.prettierrc`, `.prettierignore`
- **Adapter registry:** `dap.json` (root), `.omp/dap.json`, `examples/dap.json` — `connectMode: "tcp"`,
  `${port}` interpolated by the registry, `rootMarkers`, `launchDefaults`. Only `examples/dap.json`
  is the portable template; root/`.omp` copies carry a machine-specific absolute path.
- **Agent protocol:** `examples/agent-usage.md` — the canonical DAP wire-protocol contract for AI agents
- **Manual smoke target:** `examples/buggy.ts` — exercises source-mapped bps, closure scopes,
  conditional/logpoint bps, exception bps (`all`/`uncaught`)

## Runtime / Tooling Preferences

- **Bun is mandatory.** Run scripts with `bun run`; test with `bun test`; build with
  `bun build --target=bun`; lockfile is `bun.lock`; `types: ["bun"]`. Node cannot run the harness
  (bun-specific spawn/inspect APIs, lockfile, `bun` child processes). The `bin` entry is a `.ts`
  file, so the installed CLI only works with Bun on PATH.
- **Build artifact:** `dist/bun-dap` is a single standalone bundle (keeps `#!/usr/bin/env bun`
  shebang, no `node_modules`/install needed to run).
- **ESLint** is flat-config, type-aware (`strictTypeChecked` + `stylisticTypeChecked`). The
  `prettier/prettier` rule is **off** — formatting is owned by prettier + `eslint --fix-type layout`.
  Rule overrides carry rationale comments in `eslint.config.ts`; read them before changing rules.
- **Ignored by both prettier and eslint:** `dist/`, `.omp/`, `node_modules/`, `*.md`, `*.d.ts`,
  `*.generated.*`. `.omp/` is harness-local config — don't touch.
- **No coverage config.** Tests are contract tests, not coverage-gated.

## Testing & QA

Framework: **`bun:test`** (`import { expect, test } from 'bun:test'`; `describe` only in
`port.sourcemap.test.ts`). No `beforeEach`/`afterEach` — each test builds its own state and
cleans up with `try/finally`.

### Unit vs e2e split

**Unit (fast, mocked, no debuggee child):**
- `test/unit-adapter.test.ts` (~865 lines) — drives the engine against `MockInspector` (the only
  place that reproduces in-flight arm races, brake interleavings, multi-bp-per-pause gating).
  Asserts on recorded `mock.sent` calls and a `recordingHost()` log.
- `test/compile-log.test.ts` — `compileLogMessage` pure-function tests (runs compiled output
  via `new Function`; eslint-disabled for implied-eval).
- `test/preview.test.ts` — `formatRemoteObject` incl. getter-only descriptors, bigint/NaN/Infinity.
- `test/port.sourcemap.test.ts` — `SourceMap.fromSourceMapURL` + `NoopSourceMap`; builds an inline
  map via `bun build --sourcemap=inline` then decodes it. Also `getAvailablePort()`.
- `test/websocket-inspector.test.ts` — `WebSocketInspector`; one test uses a real `node:net` TCP
  server with a real 100ms timer (comment: fake timers wedge the bun test worker).

**e2e (spawn real `bun --inspect-wait` children / `bun run src/cli.ts` — slow, timeouts 30–60s):**
`e2e-flows.test.ts`, `adapter-control.test.ts`, `adapter.test.ts`, `attach.test.ts`,
`adapter-reuse.test.ts`, `regressions.test.ts`, `transport.test.ts`, `cli-help.test.ts`,
`cli-loopback.test.ts`, `inspector.test.ts`.

### Driving a full DAP session (e2e pattern)

`test/util/framed-client.ts` — `FramedClient`: minimal `Content-Length`-framed client; `send(command, args)`
auto-assigns seq, 10s response timeout; `waitForEvent(eventType, 10_000)`. `connectStdio()` spawns
`bun run src/cli.ts` and `close()` sends a graceful `disconnect` first then kills the child after
100ms (so the debuggee tears down via `disconnectRequest`, not transport loss). `connectTcp(port, host)`.

`test/util/dap-helpers.ts` — `launchReady` (initialize + capability assertions: `supportsConditionalBreakpoints`/
`supportsHitConditionalBreakpoints`/`supportsLogPoints`/`supportsConfigurationDoneRequest` true,
`exceptionBreakpointFilters` length 2), `armBreakpoint` (`setBreakpoints` → `setExceptionBreakpoints []`
→ `configurationDone` → poll `breakpoint` changed event up to 20×2s for `verified:true`), `breakpointVerified`,
`firstBreakpoint`, `must` (non-null), `topOf` (top stack frame).

Canonical happy flow:
```
connectStdio() → launchReady → armBreakpoint(client, fixture, line)
  → waitForEvent('stopped') → threads → stackTrace → scopes → variables → evaluate
  → continue → waitForEvent('exited') → waitForEvent('terminated')
  → finally { client.close() }
```
`threadId` is always `1` (Bun debuggees are single-threaded).

`test/util/mock-inspector.ts` — `MockInspector extends EventEmitter`: `sent[]` (every send in order),
`reply(method, result)` / `handle(method, fn)` (may return a value, promise, or throw — needed for arm
races). `delay(ms)` = `Promise.withResolvers` + `setTimeout` — the standard flush (`await delay(10–50)`
so the adapter's async `onPaused` pipelines drain). `mountAdapter(mock, host)` builds the real
`BunDebugAdapter`, wires the mock via `AdapterTestSeam` (never inline member access), and exposes
private state (`brakePending`, `firstPausePending`, `entryBreakpointId/Url`, `placeholderJscIds/Alias`)
for injection/inspection.

### Fixtures (`test/fixtures/`) — naming = behavior

| Fixture | Exercises |
|---|---|
| `hello.ts` | Workhorse: happy-path bp (line 2), stepping (lines 3-4, 7), conditions, function bp. Trailing `console.log('done')` exists because JSC refuses to resolve a deferred bp on a module's FINAL statement |
| `imports.ts` | Imports `node:path`; first executed statement is a builtin initializer BEFORE the module parses — the nvim attach deferred-bp/brake failure shape. bp target line 13 |
| `offset.ts` | 9-line comment header so TS lines diverge from generated JS; deferred arms must map through the inline source map onto the requested TS line (bp at TS line 13, hit twice) |
| `throw.ts` | One `throw new Error(...)` for exception-filter tests |
| `server.ts` | `Bun.serve` on `process.env.PORT`; pause/terminate/hitCondition/disconnect via HTTP probe |
| `sample.ts` | Input to `bun build --sourcemap=inline` in port.sourcemap.test.ts |

### What the dedicated suites guard
- `regressions.test.ts` — deferred `setBreakpoints` DAP contract: pre-gate must return
  `verified:false` + message `'pending script load'`.
- `adapter-reuse.test.ts` — `launch → disconnect → launch` on ONE TCP connection: the second
  session must build a fresh adapter (pre-fix cached adapter kept `configDoneSent=true` and hung).
  TCP-only; stdio can't reproduce. 60s timeout.
- `e2e-flows.test.ts` — deferred bps in a module WITH imports, `stopOnEntry`+deferred-bp dedupe,
  attach stepping + variable fetch at every stop (`-32000` regression), exited/terminated exactly once.
- `adapter-control.test.ts` — entry, stepping next/stepOut/stepIn, pause, terminate, conditional/
  hit-count bps, symbolic function bps, exception filter `all`, `noDebug`, symlinked program paths.
- `attach.test.ts` — detach keeps target alive, garbage ws url fails fast, `terminateDebuggee` kills target.

### Test conventions
- `expect(actual, 'label: ...')` message-first style (mandatory in e2e).
- Real timers over fake timers even in unit-adjacent tests (fake timers wedge the bun worker);
  polling loops are the accepted pattern for spawned-process readiness.
- Ports never hardcoded — `getAvailablePort()`.
- Cleanup: `try/finally`; `client.close()`; `child.kill()` for every spawned bun child; `rmSync`
  for `mkdtemp` dirs.
- ESLint strictness shows in files: `eslint-disable` comments for `no-floating-promises`,
  `no-implied-eval`, `no-unsafe-call`, `await-thenable`, `no-confusing-void-expression`.

## Gotchas an AI Assistant Must Respect

- **Do not reuse one DAP connection for a second debug session** (`launch → disconnect → launch`
  on the same connection hangs — the cached adapter keeps `configDoneSent=true` and
  `configurationDone` no-ops; the `--inspect-wait` gate never opens). stdio = one session per
  process; TCP mints a fresh session per socket (safe). See `REMAINING-ISSUES.md` A1.
- **Trust `examples/agent-usage.md` over `README.md` for stop-reason mapping.** The adapter emits
  `reason: "step"` on next/stepIn/stepOut completion; README's reason list omits it (REMAINING-ISSUES B1).
  `debugger;` statements map to `breakpoint`, not `pause` (REMAINING-ISSUES A2).
- **`variables` responses are not paged** — the adapter honors `start`/`count` but never advertises
  `indexedVariables`/`namedVariables`, so clients never page and a huge object dumps in one response (A4).
- **Realpath/symlink canonicalization is load-bearing** (`/tmp` vs `/private/tmp` on macOS). `setBreakpoints`
  and the brake's `inEntryFile` guard canonicalize via `realpathSync`; don't strip it.
- **Spawning is always argv-array** (no shell → no injection).
- **Never write to stdout** except framed DAP. Diagnostics → stderr.
- **Before editing `adapter.ts` breakpoint machinery**, read
  `skill://bun-dap-deferred-breakpoint-bug` — the placeholder/brake/alias interactions are probe-verified
  and several fixes were caught by diff review, not tests. Review the full `git diff` before committing
  adapter surgery; the edit tool has mangled brace structure here before.
