#!/usr/bin/env bun
import { createServer } from 'node:net';
import { DebugSession, Logger, logger } from '@vscode/debugadapter';
import { BunDapSession } from './session';
import { isLoopbackHost } from './util/loopback';
// stdout is sacred: only DAP framed messages. All diagnostics go to stderr.
// Internal SDK logging is disabled so nothing else leaks into the stream.
logger.setup(Logger.LogLevel.Stop, false);

const argv = process.argv.slice(2);
if (argv.length === 0) {
  // stdio single-session mode (nvim-dap type='executable').
  DebugSession.run(BunDapSession);
} else {
  // TCP server mode: `bun run src/cli.ts <port> [host]`.
  const port = Number(argv[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`usage: bun run src/cli.ts <port 1-65535> [host]\n`);
    process.exit(1);
  }
  const host = argv[1] ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    // Non-fatal: the user asked for a non-loopback bind, but it exposes an
    // unauthenticated evaluate/RCE surface to every reachable peer. Warn
    // in-band at the moment the risk is taken; do not refuse to start.
    process.stderr.write(`bun-dap: warning: binding ${host} exposes an unauthenticated evaluate/RCE surface; prefer 127.0.0.1\n`);
  }
  const server = createServer((socket) => {
    const session = new BunDapSession();
    session.setRunAsServer(true); // don't exit the process when this socket closes
    session.start(socket, socket); // ProtocolServer.start binds Content-Length framing
    // M8: a dropped connection (client killed without disconnect) would orphan
    // the launched debuggee — terminate it before stopping the session.
    socket.on('close', () => {
      try { void session.terminateDebuggee(); } catch { /* already gone */ }
      session.stop();
    });
  });
  server.on('error', (err) => {
    process.stderr.write(`bun-dap: server error: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    process.stderr.write(`bun-dap listening on ${host}:${port}\n`);
  });
}