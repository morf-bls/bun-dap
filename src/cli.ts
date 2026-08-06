#!/usr/bin/env bun
import { BunDapSession } from './session';
import { isLoopbackHost } from './util/loopback';
import { DebugSession, Logger, logger } from '@vscode/debugadapter';
import { createServer } from 'node:net';

// stdout is sacred: only DAP framed messages. All diagnostics go to stderr.
// Internal SDK logging is disabled so nothing else leaks into the stream.
logger.setup(Logger.LogLevel.Stop, false);

const HELP = `bun-dap — a Debug Adapter Protocol (DAP) server for Bun

Usage:
  bun run src/cli.ts                stdio DAP mode (default; nvim-dap type='executable')
  bun run src/cli.ts <port> [host]  TCP DAP server; host defaults to 127.0.0.1

Options:
  -h, --help                        print this help and exit

Notes:
  stdout carries only framed DAP messages; diagnostics go to stderr.
  Binding a non-loopback host exposes an unauthenticated evaluate/RCE surface.
`;

// [0] - bun, [1] - src/cli.ts, [2..] - user args
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
}
if (argv.length === 0) {
    // stdio single-session mode (nvim-dap type='executable').
    DebugSession.run(BunDapSession);
} else {
    const port = Number(argv[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        process.stderr.write(
            `usage: bun run src/cli.ts <port 1-65535> [host]\nTry 'bun run src/cli.ts --help' for details.\n`
        );
        process.exit(1);
    }
    const host = argv[1] ?? '127.0.0.1';
    if (!isLoopbackHost(host)) {
        // Non-fatal: the user asked for a non-loopback bind, but it exposes an
        // unauthenticated evaluate/RCE surface to every reachable peer. Warn
        // in-band at the moment the risk is taken; do not refuse to start.
        process.stderr.write(
            `bun-dap: warning: binding ${host} exposes an unauthenticated evaluate/RCE surface; prefer 127.0.0.1\n`
        );
    }
    const server = createServer((socket) => {
        const session = new BunDapSession();
        session.setRunAsServer(true); // don't exit the process when this socket closes
        session.start(socket, socket); // ProtocolServer.start binds Content-Length framing
        // A dropped connection (client killed without disconnect) would orphan
        // the launched debuggee — terminate it before stopping the session.
        socket.on('close', () => {
            try {
                session.terminateDebuggee();
            } catch {
                /* already gone */
            }
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
