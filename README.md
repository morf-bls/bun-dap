# bun-dap

A standalone, IDE-agnostic Debug Adapter Protocol (DAP) server for [Bun](https://bun.sh).
It drives Bun's JSC inspector (`--inspect`, `--inspect-wait`, `--inspect-brk`)
and exposes the standard Debug Adapter Protocol over stdio or TCP, so any DAP
client — Neovim (nvim-dap), an omp-style harness, or an AI agent — gets
launch/attach, source-mapped breakpoints, stepping, locals, and REPL evaluation
for TypeScript and JavaScript.

Bun ships no published debug adapter outside its VS Code extension; bun-dap
re-implements the DAP⇄JSC translation leanly in TypeScript (runtime: Bun) on top
of Microsoft's DAP framing libraries.

## Quick start

```sh
bun install
bun run src/cli.ts          # stdio DAP server (default)
bun run src/cli.ts 4711     # TCP DAP server on 127.0.0.1:4711
bun run src/cli.ts 4711 0.0.0.0
```

`stdout` carries only framed DAP messages; all diagnostics go to `stderr`.

## Neovim (nvim-dap)

See [`examples/nvim-dap.lua`](examples/nvim-dap.lua):

```lua
dap.adapters.bun = {
  type = 'executable',
  command = 'bun',
  args = { 'run', '/path/to/bun-dap/src/cli.ts' },
}
dap.configurations.typescript = {
  { type = 'bun', request = 'launch', name = 'Debug Bun', program = '${file}', cwd = '${workspaceFolder}' },
}
```

Attach: start the target with `bun --inspect`, copy the `ws://` URL from its
stderr into the `attach` configuration.

## omp harness

See [`examples/dap.json`](examples/dap.json) — a `dap.json` shape mirroring the
existing vscode-js-debug adapter entry, with the command repointed at bun-dap's
TCP mode (`${port}` + `connectMode: "tcp"`).

## AI agents

[`examples/agent-usage.md`](examples/agent-usage.md) documents the wire
protocol: the exact `initialize → launch → setBreakpoints → configurationDone →
stopped → stackTrace/scopes/variables/evaluate → continue → terminated`
sequence with `Content-Length` framing, plus the deferred-breakpoint and
logpoint behaviors.

## Debugging a program

```sh
# Launch (the adapter spawns the child with --inspect-wait)
bun run src/cli.ts   # then drive DAP from your client

# Attach (target must already run with an inspector)
bun --inspect=127.0.0.1:6499 app.ts
# → ws://127.0.0.1:6499/<uuid> on stderr; pass that URL to `attach`
```

Launch arguments (DAP `launch`):

| field        | meaning                                              | default          |
| ------------ | ---------------------------------------------------- | ---------------- |
| `program`    | absolute path of the TS/JS entry (required)          | —                |
| `args`       | argv for the program                                 | `[]`             |
| `cwd`        | working directory                                    | `process.cwd()`  |
| `env`        | extra environment for the child                      | inherited        |
| `runtime`    | executable to run (defaults to `bun`)                | `bun`            |
| `runtimeArgs`| flags before the program                             | `[]`             |
| `stopOnEntry`| pause at program entry                               | `false`          |
| `noDebug`    | run without inspector; breakpoints are inert         | `false`          |

Attach arguments (DAP `attach`): `url` — the `ws://host:port/uuid` inspector
URL. `disconnect` with `terminateDebuggee: false` (or omitted) detaches and
leaves the target running.

## Supported DAP surface

Requests: `initialize`, `launch`, `attach`, `disconnect`, `terminate`,
`setBreakpoints` (line breakpoints with `condition`, `hitCondition`,
`logMessage`), `setFunctionBreakpoints`, `setExceptionBreakpoints`,
`configurationDone`, `threads`, `stackTrace`, `scopes`, `variables`,
`evaluate`, `continue`, `next`, `stepIn`, `stepOut`, `pause`.

Events: `initialized`, `stopped`, `terminated`, `exited`, `thread`, `process`,
`output` (stdout/stderr/console — logpoints), `breakpoint` (changed when a
deferred breakpoint verifies).

Exception filters: `all` and `uncaught`. Bun/JSC pauses on all exceptions when
either is enabled (no clean uncaught-only mode — the `uncaught` label says so).

Deliberately deferred (advertised `false` in capabilities): `source`,
`goto`/`gotoTargets`, `completions`, `setVariable`, `setExpression`,
`exceptionInfo`, `breakpointLocations`, `loadedSources`, `restart`,
`restartFrame`, `stepBack`, `reverseContinue`, data/instruction breakpoints,
read/write memory, disassemble, cancel.

## How it works

1. `launch` spawns `bun --inspect-wait=127.0.0.1:<port> program`, scrapes the
   `ws://` inspector URL off stderr, and connects.
2. Breakpoints are set on the **TypeScript** path; JSC resolves them against
   the module's inline source map. Before the module parses
   (`--inspect-wait` gate still closed), the breakpoint is deferred by the
   engine and reported `verified:false` with `message: "pending script load"`;
   a `breakpoint` changed event marks it verified once the script parses.
3. `configurationDone` sends `Debugger.setBreakpointsActive` +
   `Inspector.initialized` — the gate opens and the program runs.
4. On `Debugger.paused`, hit breakpoints gate on `condition`/`hitCondition`,
   logpoints print via `output` events and resume, and the stop reason is
   mapped to DAP (`Breakpoint` → `breakpoint`, `FunctionCall` →
   `function breakpoint`, exceptions → `exception`, entry pauses → `entry`).
5. `stackTrace` maps generated JS locations back through the source map, so
   frames show TypeScript lines.

## Development

```sh
bun install
bun test            # full suite (spawns real bun children)
bun run typecheck   # tsc --noEmit
```

Test layout: `test/port.sourcemap.test.ts` (source-map round-trips),
`test/inspector.test.ts` (raw inspector driving), `test/adapter.test.ts`
(end-to-end launch: breakpoint → stop → locals → evaluate → exit; plus a
logpoint case), `test/attach.test.ts` (attach to a running server, detach keeps
it alive), `test/transport.test.ts` (stdio + TCP framing).

## Layout

```
src/cli.ts                       stdio/TCP transport entry
src/session.ts                   DAP session: dispatch + adapter→event bridge
src/adapter/adapter.ts           the DAP⇄JSC engine
src/sourcemap.ts                 source-map-js wrapper (1/0-based discipline)
src/inspector/websocket-inspector.ts  typed JSC inspector client
src/inspector/jsc-types.ts       JSC protocol types
src/inspector/preview.ts         RemoteObject formatting
src/util/port.ts                 free-port picker
examples/                        nvim-dap, dap.json, agent-usage
```
