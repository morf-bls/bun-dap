import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { connectTcp, type FramedClient } from './util/framed-client';
import { castObject } from './util/dap-helpers';
import { getAvailablePort } from '../src/util/port';

// A1: a launch → disconnect → launch cycle on ONE TCP connection must reuse the
// session but build a FRESH adapter. Pre-fix the cached adapter kept
// configDoneSent=true, so configurationDone() no-oped, the --inspect-wait gate
// never opened, and the second debuggee hung forever. The TCP server mints a
// new BunDapSession per socket, so this bug is per-connection (one socket,
// two launch cycles), not per-socket — stdio can't reproduce it (the process
// exits after disconnect).

const repoRoot = resolve(import.meta.dir, '..');
const hello = resolve(repoRoot, 'test/fixtures/hello.ts');

/** Drive one full launch→exit→terminated cycle on `client`. */
async function runOnce(client: FramedClient, label: string): Promise<void> {
  const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
  expect(init.success, `${label}: init`).toBe(true);
  const launched = await client.send('launch', { program: hello, cwd: repoRoot, runtime: 'bun', stopOnEntry: false, noDebug: false });
  expect(launched.success, `${label}: launch`).toBe(true);
  await client.waitForEvent('initialized', 10_000);
  const exc = await client.send('setExceptionBreakpoints', { filters: [] });
  expect(exc.success, `${label}: setExceptionBreakpoints`).toBe(true);
  const done = await client.send('configurationDone', {});
  expect(done.success, `${label}: configurationDone`).toBe(true);
  // hello.ts runs to completion once the --inspect-wait gate opens.
  const exited = await client.waitForEvent('exited', 15_000);
  expect(castObject(exited.body).exitCode, `${label}: exitCode 0`).toBe(0);
  await client.waitForEvent('terminated', 15_000);
}

test('A1: launch → disconnect → launch on one connection does not hang', async () => {
  const port = await getAvailablePort();
  const server = Bun.spawn(['bun', 'run', 'src/cli.ts', String(port), '127.0.0.1'], {
    cwd: repoRoot,
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  try {
    // Wait for the TCP server to bind.
    await new Promise<void>((res, rej) => {
      const deadline = setTimeout(() => rej(new Error('cli never listened')), 10_000);
      void (async () => {
        for await (const chunk of server.stderr as AsyncIterable<Uint8Array>) {
          if (Buffer.from(chunk).toString('utf8').includes('listening')) {
            clearTimeout(deadline);
            res();
            return;
          }
        }
        clearTimeout(deadline);
        rej(new Error('cli stderr closed without listening'));
      })();
    });

    const client = await connectTcp(port, '127.0.0.1');
    try {
      // First session: run to completion, then disconnect.
      await runOnce(client, 'first');
      const disc = await client.send('disconnect', {});
      expect(disc.success, 'disconnect first').toBe(true);

      // Second session ON THE SAME SOCKET: pre-fix the cached adapter's
      // configDoneSent was still true, so configurationDone() no-oped, the
      // gate never opened, and the second debuggee hung at the entry module.
      // After the fix, getAdapter() builds a fresh adapter and this completes.
      await runOnce(client, 'second');
    } finally {
      client.close();
    }
  } finally {
    try { server.kill(); } catch { /* already gone */ }
  }
}, 60_000);
