import { test, expect } from 'bun:test';
import { spawn } from 'bun';
import { resolve } from 'node:path';
import { getAvailablePort } from '../src/util/port';
import { connectStdio, connectTcp } from './util/framed-client';

const repoRoot = resolve(import.meta.dir, '..');

function capabilitiesOf(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

test('stdio transport: initialize handshake over Content-Length framing', async () => {
  const client = connectStdio();
  try {
    const resp = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(resp.success).toBe(true);
    expect(resp.command).toBe('initialize');
    expect(capabilitiesOf(resp.body).supportsConfigurationDoneRequest).toBe(true);
  } finally {
    client.close();
  }
});

test('tcp transport: server keeps listening after a client disconnects', async () => {
  const port = await getAvailablePort();
  const proc = spawn(['bun', 'run', 'src/cli.ts', String(port), '127.0.0.1'], {
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    // Wait for the listening banner on stderr.
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const deadline = setTimeout(() => reject(new Error('server never printed listening banner')), 10_000);
    void (async () => {
      for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
        if (Buffer.from(chunk).toString('utf8').includes('bun-dap listening')) {
          clearTimeout(deadline);
          resolve();
          return;
        }
      }
    })();
    await promise;

    const client = await connectTcp(port);
    const resp = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(resp.success).toBe(true);
    client.close();

    // The server must accept a fresh session after the disconnect.
    await Bun.sleep(150);
    const client2 = await connectTcp(port);
    const resp2 = await client2.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(resp2.success).toBe(true);
    client2.close();
  } finally {
    proc.kill();
  }
});
