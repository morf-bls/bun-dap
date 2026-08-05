# bun-dap

A standalone, IDE-agnostic [Debug Adapter Protocol][dap] (DAP) **server** for [Bun][bun].

bun-dap drives Bun's JavaScriptCore inspector (`--inspect`, `--inspect-wait`,
`--inspect-brk`) and exposes the standard DAP over stdio or TCP — so *any* DAP
client gets launch/attach, source-mapped breakpoints, stepping, scopes &
locals, and REPL evaluation for TypeScript and JavaScript running on Bun.

> [!IMPORTANT]
> Bun ships **no published debug adapter** outside its [VS Code
> extension][bun-vscode]. bun-dap is that missing piece for everyone who isn't
> in VS Code: Neovim, Helix, the oh-my-pi harness, and AI coding agents.

## Why bun-dap exists

Bun's official debugger is the [Bun VS Code extension][bun-vscode] — and it is
good. It is also, by construction, **only usable inside VS Code**. bun-dap
exists because everything outside that editor — Neovim, Helix, Emacs, the
oh-my-pi harness, AI coding agents — speaks the same [Debug Adapter
Protocol][dap] but has no Bun adapter to talk to.

Three facts about the official stack explain why "just reuse it" doesn't work:

1. **The VS Code extension hosts its adapter inline — there is no server to wrap.**
   [`features/debug.ts`][vscode-debug-ts] registers an `InlineDebugAdapterFactory`
   that hands VS Code a `DebugAdapterInlineImplementation` running *inside the
   extension host*, coupled to the `vscode` API (workspace config, terminals,
   codelens, diagnostics). The [manifest's][vscode-pkg] static
   `program: "dist/adapter.js"` entry is never even built —
   [`build.mjs`][vscode-build-mjs] bundles only `extension.ts` and
   `web-extension.ts`. No adapter process exists that Neovim or an agent could
   spawn.
2. **The engine behind it is an unpublished monorepo library with no DAP transport.**
   [`bun-debug-adapter-protocol`][bdap] (`0.0.1`, not on npm) does contain the
   real DAP⇄JSC translation — launch/spawn, source maps, deferred breakpoints —
   and it is what the extension drives in-process. But its README is a single
   link, it imports its inspector client from a sibling monorepo package
   ([`bun-inspector-protocol`][bip], also unpublished), and it has **no DAP wire
   transport at all**: hosts call adapter methods directly, and its only framer
   is the 4-byte inspector socket framing, not DAP `Content-Length`. Consuming
   it means vendoring two moving monorepo packages and writing the transport
   yourself.
3. **Non-VS-Code clients exercise orderings the official stack never sees.**
   nvim-dap and agents send breakpoints before the target's scripts have parsed
   — before `configurationDone`, before the first `scriptParsed`. Those
   breakpoints must be deferred, mapped through the inline source map the moment
   the script parses, and held against a frozen entry module. That machinery is
   first-class in bun-dap and verified by its end-to-end suite and real nvim-dap
   sessions — not merely assumed to work because debugging works in VS Code.

bun-dap is therefore a **standalone DAP server** for Bun: spawn it over stdio
or connect over TCP, running on the **Bun runtime** itself, built on Microsoft's
[`@vscode/debugadapter`][vscode-da] framing, and shaped to be publishable and
owned by its users.

| | bun‑dap (this project) | [`bun-debug-adapter-protocol`][bdap] | [`bun-vscode`][bun-vscode] |
|---|---|---|---|
| What it is | Runnable DAP **server** | DAP⇄JSC engine **library** | VS Code **extension** |
| Distribution | Publishable package + CLI | Unpublished monorepo lib (`0.0.1`) | VS Code Marketplace |
| DAP transport | stdio **and** TCP | none (host calls methods in-process) | none (inline in extension host) |
| Runs on | **Bun** | Bun or Node (as a library) | VS Code extension host |
| Neovim / Helix / agents | ✅ | ❌ (nothing to spawn) | ❌ |
| VS Code | ✅ (as a plain DAP server) | drives the extension | ✅ (native) |
| DAP surface | core set, verified | broader (`setVariable`, `completions`, `exceptionInfo`, …) | broader |
| Verified clients | nvim-dap, agent harnesses | VS Code only | VS Code only |
| Test runner, error overlays, lockfile viewer | — | — | ✅ |
| License / affiliation | MIT, independent community | MIT (Oven) | MIT (Oven) |

**Relationship to upstream.** [`bun-inspector-protocol`][bip] is already
package-shaped (`files`, `LICENSE`, build script), so Oven appears to be
staging these packages for publication. If `bun-debug-adapter-protocol` ships
on npm with semver, bun-dap's transport/session layer is engine-agnostic and
could host the official engine behind it. Until then, an independent
implementation is the only route to a verifiable, publishable artifact.

bun-dap is an **independent community project**. It is not affiliated with Oven
and shares no code with `bun-debug-adapter-protocol`; the translation layer is
written from the JSC inspector up.

## Quick start

```sh
bun install
bun run src/cli.ts          # stdio DAP server (default)
bun run src/cli.ts 4711     # TCP DAP server on 127.0.0.1:4711
bun run src/cli.ts 4711 0.0.0.0
```

`stdout` carries **only** framed DAP messages; all diagnostics go to `stderr`.
This is deliberate and load-bearing — AI agents parse `stdout` as pure DAP.

## Usage scenarios

### Scenario A — Neovim (`nvim-dap`)

The recommended config, with launch **and** attach flows:

```lua
local dap = require('dap')

dap.adapters.bun = {
  type = 'executable',
  command = 'bun',
  args = { 'run', '/path/to/bun-dap/src/cli.ts' },
}

dap.configurations.typescript = {
  {
    type = 'bun', request = 'launch', name = 'Launch Bun',
    program = '${file}', cwd = '${workspaceFolder}',
  },
  {
    type = 'bun', request = 'attach', name = 'Attach to Bun',
    -- start the target first: bun --inspect-wait=127.0.0.1:6499/debugme ./app.ts
    url = 'ws://127.0.0.1:6499/debugme',
  },
}
dap.configurations.javascript = dap.configurations.typescript
```

- **Launch:** open a `.ts`/`.js` file, set a breakpoint with your mapping
  (e.g. `<leader>b`), then `:lua require('dap').continue()` — the adapter
  spawns the child with `--inspect-wait` and connects.
- **Attach:** start the target with `bun --inspect` (or `--inspect-wait`), copy
  the `ws://` URL it prints on `stderr`, then run the **Attach to Bun** config.

Full file: [`examples/nvim-dap.lua`](examples/nvim-dap.lua).

> [!TIP]
> Breakpoints set *before* the program parses report `verified:false` and flip
> to `verified:true` via a `breakpoint` event once the script loads. This is
> correct behavior — see [How it works](#how-it-works). If your DAP UI shows
> "breakpoint not yet bound," just `continue` and let the deferred arm land.

### Scenario B — oh-my-pi harness (`dap.json`)

The oh-my-pi harness reads a `dap.json` adapter registry and drives the
`xd://debug` tool over TCP. The entry mirrors the
vscode-js-debug adapter shape, repointed at bun-dap's TCP mode:

```json
{
  "adapters": {
    "bun-dap": {
      "command": "bun",
      "args": ["run", "/path/to/bun-dap/src/cli.ts", "${port}", "127.0.0.1"],
      "connectMode": "tcp",
      "languages": ["typescript", "javascript"],
      "fileTypes": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      "rootMarkers": ["bun.lock", "package.json", "tsconfig.json"],
      "launchDefaults": { "request": "launch", "type": "bun", "runtime": "bun", "stopOnEntry": true }
    }
  }
}
```

The harness `connect (${port})`s to the TCP server, completes the
`initialize → launch → setBreakpoints → configurationDone` handshake, and
surfaces `stopped` events as breakpoints you can step through with the
`xd://debug` actions (`continue`, `next`, `stepIn`, `stepOut`, `stackTrace`,
`scopes`, `variables`, `evaluate`). `stopOnEntry: true` in `launchDefaults`
freezes the entry module so deferred breakpoints arm before execution proceeds.
Full file: [`examples/dap.json`](examples/dap.json).

### Scenario C — AI agents

bun-dap is the debugger backend for AI coding agents. An agent spawns the
adapter, speaks raw DAP over `Content-Length`-framed stdio, and drives the full
`initialize → launch → setBreakpoints → configurationDone → stopped →
stackTrace/scopes/variables/evaluate → continue → terminated` sequence to set
breakpoints, inspect state, and step through a program — with source-map-correct
TypeScript lines, no manual JS-line guessing.

[`examples/agent-usage.md`](examples/agent-usage.md) documents the complete wire
protocol: exact message shapes, framing rules, the deferred-breakpoint and
logpoint flows, and TCP mode. A runnable end-to-end sequence lives in
[`test/adapter.test.ts`](test/adapter.test.ts).

Example — set a conditional breakpoint and read locals while paused:

```json
{"seq":3,"type":"request","command":"setBreakpoints","arguments":{
  "source":{"path":"/abs/path/app.ts"},
  "breakpoints":[{"line":12,"condition":"subtotal > 100"}]}}
```

```json
{"seq":6,"type":"request","command":"evaluate","arguments":{
  "expression":"subtotal.toFixed(2)","frameId":1,"context":"repl"}}
```

### Scenario D — any other DAP client

Because bun-dap speaks vanilla DAP, it works with anything that expects a
[standalone debug adapter][dap-implementations]: Helix, Emacs (`dap-mode`), Theia,
Eclipse, or a hand-rolled client. Spawn it in stdio mode for an in-process
session, or use TCP mode to serve multiple sequential connections (each gets a
fresh session; the server keeps listening after a client disconnects).

## Debugging a program

```sh
# Launch (the adapter spawns the child with --inspect-wait)
bun run src/cli.ts   # then drive DAP from your client

# Attach (target must already run with an inspector)
bun --inspect=127.0.0.1:6499 ./app.ts
# → ws://127.0.0.1:6499/<uuid> on stderr; pass that URL to `attach`
```

### Launch arguments (DAP `launch`)

| field         | meaning                                       | default         |
|---------------|-----------------------------------------------|-----------------|
| `program`     | absolute path of the TS/JS entry (**required**) | —               |
| `args`        | argv for the program                          | `[]`            |
| `cwd`         | working directory                             | `process.cwd()` |
| `env`         | extra environment for the child              | inherited       |
| `runtime`     | executable to run (defaults to `bun`)        | `bun`           |
| `runtimeArgs` | flags before the program                      | `[]`            |
| `stopOnEntry` | pause at program entry                        | `false`         |
| `noDebug`     | run without inspector; breakpoints are inert | `false`         |

### Attach arguments (DAP `attach`)

`url` — the `ws://host:port/uuid` inspector URL printed by `bun --inspect`.
`disconnect` with `terminateDebuggee: false` (or omitted) **detaches** and
leaves the target running; `terminateDebuggee: true` kills it.

## How it works

1. **`launch`** spawns `bun --inspect-wait=127.0.0.1:<port> program`, scrapes
   the `ws://` inspector URL off `stderr`, and connects.
2. **Deferred breakpoints.** Breakpoints are set on the **TypeScript** path, but
   JSC resolves URL-keyed breakpoints against *generated* lines, never TS lines.
   Before the module parses (the `--inspect-wait` gate still closed), the
   breakpoint is *deferred*: the adapter keeps it pending and reports
   `verified:false`. When the script parses, its inline source map is decoded
   **synchronously** from `scriptParsed.sourceMapURL` (no RPC), the breakpoint
   arms at its mapped generated coordinates, and a `breakpoint` changed event
   marks it `verified:true`. A one-shot pre-gate `Debugger.pause` freezes the
   entry module at its first statement until those arms land; if a breakpoint's
   target *is* that statement, the pause stands in for its hit.
3. **`configurationDone`** sends `Debugger.setBreakpointsActive` +
   `Inspector.initialized` — the gate opens and the program runs.
4. **On `Debugger.paused`**, hit breakpoints gate on `condition`/`hitCondition`,
   logpoints print via `output` events and resume, and the stop reason is
   mapped to DAP (`Breakpoint` → `breakpoint`, `FunctionCall` →
   `function breakpoint`, exceptions → `exception`, entry pauses → `entry`,
   manual/debugger pauses → `pause`).
5. **`stackTrace`** maps generated JS locations back through the source map, so
   frames render with TypeScript lines.

A deliberately-buggy program for manual exploration lives at
[`examples/buggy.ts`](examples/buggy.ts) — it exercises source-mapped
breakpoints, closure scopes, conditional/logpoint breakpoints, and exception
breakpoints (`all`/`uncaught`).

## Supported DAP surface

**Requests:** `initialize`, `launch`, `attach`, `disconnect`, `terminate`,
`setBreakpoints` (line breakpoints with `condition`, `hitCondition`,
`logMessage`), `setFunctionBreakpoints`, `setExceptionBreakpoints`,
`configurationDone`, `threads`, `stackTrace`, `scopes`, `variables`,
`evaluate`, `continue`, `next`, `stepIn`, `stepOut`, `pause`.

**Events:** `initialized`, `stopped`, `terminated`, `exited`, `thread`,
`process`, `output` (stdout/stderr/console — incl. logpoints), `breakpoint`
(changed when a deferred breakpoint verifies).

**Exception filters:** `all` and `uncaught`. Bun/JSC pauses on all exceptions
when either is enabled — there is no clean uncaught-only mode, and the
`uncaught` filter label says so.

**Deliberately unsupported** (advertised `false` in capabilities):
`source`, `goto`/`gotoTargets`, `completions`, `setVariable`, `setExpression`,
`exceptionInfo`, `breakpointLocations`, `loadedSources`, `restart`,
`restartFrame`, `stepBack`, `reverseContinue`, data/instruction breakpoints,
read/write memory, disassemble, `cancel`.

## Development

```sh
bun install
bun test            # full suite (spawns real bun children)
bun run typecheck   # tsc --noEmit
bun run build       # standalone binary → dist/bun-dap
```

Test layout:

- [`test/adapter.test.ts`](test/adapter.test.ts) — end-to-end launch:
  breakpoint → stop → locals → evaluate → exit; plus a logpoint case.
- [`test/attach.test.ts`](test/attach.test.ts) — attach to a running server;
  detach keeps it alive.
- [`test/port.sourcemap.test.ts`](test/port.sourcemap.test.ts) — source-map
  round-trips.
- [`test/inspector.test.ts`](test/inspector.test.ts) — raw JSC inspector
  driving.
- [`test/e2e-flows.test.ts`](test/e2e-flows.test.ts),
  [`test/adapter-control.test.ts`](test/adapter-control.test.ts),
  [`test/transport.test.ts`](test/transport.test.ts) — framing, control, and
  stdio/TCP transport.

## Layout

```
src/cli.ts                           stdio/TCP transport entry
src/session.ts                       DAP session: dispatch + adapter→event bridge
src/adapter/adapter.ts               the DAP⇄JSC engine
src/sourcemap.ts                     source-map-cs wrapper (1/0-based discipline)
src/inspector/websocket-inspector.ts typed JSC inspector client
src/inspector/jsc-types.ts           JSC protocol types
src/inspector/preview.ts             RemoteObject formatting
src/util/port.ts                     free-port picker
examples/                            nvim-dap, dap.json, agent-usage, buggy.ts
test/                                end-to-end, attach, sourcemap, transport
```

## License

MIT. bun-dap is an independent community project, unaffiliated with Oven
Shark, Inc. Bun is a trademark of its respective owners.

[dap]: https://microsoft.github.io/debug-adapter-protocol/
[dap-implementations]: https://microsoft.github.io/debug-adapter-protocol/implementors/tools/
[bun]: https://bun.sh/
[bun-vscode]: https://github.com/oven-sh/bun/tree/main/packages/bun-vscode
[bdap]: https://github.com/oven-sh/bun/tree/main/packages/bun-debug-adapter-protocol
[vscode-pkg]: https://github.com/oven-sh/bun/blob/main/packages/bun-vscode/package.json
[vscode-da]: https://github.com/microsoft/vscode-debugadapter-node
[bip]: https://github.com/oven-sh/bun/tree/main/packages/bun-inspector-protocol
[vscode-debug-ts]: https://github.com/oven-sh/bun/blob/main/packages/bun-vscode/src/features/debug.ts
[vscode-build-mjs]: https://github.com/oven-sh/bun/blob/main/packages/bun-vscode/scripts/build.mjs
