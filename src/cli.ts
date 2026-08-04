#!/usr/bin/env bun
import { createServer } from 'node:net';
import { DebugSession, Logger, logger } from '@vscode/debugadapter';
import { BunDapSession } from './session';

// stdout is sacred: only DAP framed messages. All diagnostics go to stderr.
// Internal SDK logging is disabled so nothing else leaks into the stream.
logger.setup(Logger.LogLevel.Stop, false);

const argv = process.argv.slice(2);
if (argv.length === 0) {
  // stdio single-session mode (nvim-dap type='executable').
  DebugSession.run(BunDapSession);
} else {
  // TCP server mode: `bun run src/cli.ts <port> [host]`.
  const port = parseInt(argv[0] ?? '', 10);
  const host = argv[1] ?? '127.0.0.1';
  const server = createServer((socket) => {
    const session = new BunDapSession();
    session.setRunAsServer(true); // don't exit the process when this socket closes
    session.start(socket, socket); // ProtocolServer.start binds Content-Length framing
    socket.on('close', () => session.stop());
  });
  server.listen(port, host, () => {
    process.stderr.write(`bun-dap listening on ${host}:${port}\n`);
  });
}