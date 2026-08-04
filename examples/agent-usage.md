# Driving bun-dap from an AI agent

bun-dap is a Debug Adapter Protocol (DAP) **server**. It speaks DAP over stdin/stdout
(stdio mode) or over a TCP port. It translates DAP requests into Bun's JSC
inspector protocol, so an agent (or any DAP client) can set breakpoints, read
locals, evaluate expressions, and step through TypeScript/JavaScript running on
Bun — with source-map-correct lines.

## Conventions (non-negotiable)

- **stdout carries ONLY DAP framed messages.** Any diagnostics, banners, or logs
  go to stderr. Parse stdout as pure DAP; read stderr for human diagnostics.
- Messages are `Content-Length` framed:

  ```
  Content-Length: <byte length of the JSON body>\r\n\r\n<JSON body>
  ```

  The length is the **byte** length of the UTF-8 body, not the character count.

- Lines and columns are **1-based** in DAP. Breakpoint lines are TypeScript
  source lines; the adapter maps them to generated JS internally.
- Bun debuggees have a single thread: `threadId` is always `1`.
- A `launch` session kills the debuggee on `disconnect`; an `attach` session
  leaves the debuggee running unless `terminateDebuggee: true`.

## Minimal launch-and-breakpoint session (stdio)

Spawn the adapter: `bun run /path/to/bun-dap/src/cli.ts` (no args = stdio mode).

1. **initialize** — the handshake; read the capabilities:

   ```json
   {"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"bun-dap","pathFormat":"path","linesStartAt1":true,"columnsStartAt1":true}}
   ```

   Response `body` advertises `supportsConfigurationDoneRequest`, conditional /
   hit-conditional / logpoint breakpoints, `exceptionBreakpointFilters`
   (`all`, `uncaught`), and `supportsTerminateRequest`.

2. **launch** (or **attach**):

   ```json
   {"seq":2,"type":"request","command":"launch","arguments":{"program":"/abs/path/app.ts","cwd":"/abs/workdir","runtime":"bun","stopOnEntry":false,"noDebug":false}}
   ```

   ```json
   {"seq":2,"type":"request","command":"attach","arguments":{"url":"ws://127.0.0.1:6499/<uuid>"}}
   ```

   The `attach` url is the one `bun --inspect` prints on stderr.

3. **Wait for the `initialized` event** (sent once the inspector connects).
   Do not send breakpoints before it.

4. **setBreakpoints** — full replacement per file:

   ```json
   {"seq":3,"type":"request","command":"setBreakpoints","arguments":{"source":{"path":"/abs/path/app.ts"},"breakpoints":[{"line":12}]}}
   ```

   If the module has not parsed yet (typical: `--inspect-wait` before
   `configurationDone`), the response is `verified:false` with
   `message:"pending script load"`; a `breakpoint` event (`reason:"changed"`)
   arrives once the script parses and the breakpoint verifies. Poll events
   until `verified:true` before assuming it will hit.

5. **setExceptionBreakpoints** + **configurationDone**:

   ```json
   {"seq":4,"type":"request","command":"setExceptionBreakpoints","arguments":{"filters":[]}}
   {"seq":5,"type":"request","command":"configurationDone","arguments":{}}
   ```

   `configurationDone` releases the `--inspect-wait` gate — the program only
   starts running after this request.

6. **Wait for `stopped`** when a breakpoint hits:

   ```json
   {"type":"event","event":"stopped","body":{"reason":"breakpoint","threadId":1,"hitBreakpointIds":[1]}}
   ```

   `reason` is `breakpoint`, `exception`, `entry` (stopOnEntry), `pause`
   (manual pause / debugger statement), or `function breakpoint`.

7. **Inspect while paused** — the waterfall:

   - `threads` → `{ "threads": [{ "id": 1, "name": "main" }] }`
   - `stackTrace` `{ "threadId":1, "startFrame":0, "levels":10 }` → frames;
     `line` is the **TypeScript** line (source-mapped). Keep the top frame's
     `id`.
   - `scopes` `{ "frameId": <id> }` → scopes incl. `Local`; keep its
     `variablesReference`.
   - `variables` `{ "variablesReference": <ref> }` → variable list.
   - `evaluate` `{ "expression":"name.toUpperCase()","frameId":<id>,"context":"repl" }`
     → `{ "result": "'WORLD'" }` (evaluated on the paused frame).

8. **Resume / step**: `continue` `{ "threadId":1 }`, `next`, `stepIn`, `stepOut`
   (each `{ "threadId":1 }`; next/stepIn/stepOut take a frameId in some DAP
   flavors — here threadId suffices), or `pause` while running.

9. **Finish**: the debuggee emits `exited` `{ "exitCode":0 }` then `terminated`.
   Or send `disconnect` — with `{ "terminateDebuggee": true }` to kill an
   attach target, omitted/false to detach and let it keep running.

## Logpoints and conditions

Breakpoints support `condition` (JavaScript expression evaluated on the paused
frame; falsy → skip), `hitCondition` (positive integer N; stops on the Nth
hit), and `logMessage` (template with `${expr}` interpolation; prints an
`output` event `category:"console"` and **never stops**):

```json
{"seq":3,"type":"request","command":"setBreakpoints","arguments":{"source":{"path":"/abs/path/app.ts"},"breakpoints":[{"line":12,"logMessage":"hit: ${name}"}]}}
```

## TCP mode

`bun run /path/to/bun-dap/src/cli.ts <port> [host]` listens for DAP connections
on TCP (host defaults to 127.0.0.1). Each connection gets a fresh session; the
server keeps listening after a client disconnects. Diagnostics (`bun-dap
listening on ...`) go to stderr.

## Quick check

A 30-second sanity probe: spawn the adapter, send `initialize`, then `launch`
with `program` pointing at a file containing `console.log('hi')`, wait for
`initialized`, send `setBreakpoints` on a line inside the file,
`configurationDone`, and confirm a `stopped` event with
`reason:"breakpoint"`. `test/adapter.test.ts` is the full end-to-end sequence
in runnable form.
