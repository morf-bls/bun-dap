import { test, expect } from 'bun:test';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { getAvailablePort } from '../src/util/port';
import { WebSocketInspector } from '../src/inspector/websocket-inspector';

const server = resolve(import.meta.dir, 'fixtures/server.ts');

/** Scrape the inspector ws:// URL off a bun --inspect-wait child's stderr. */
async function scrapeInspectorUrl(child: Bun.Subprocess): Promise<string> {
  let stderrText = '';
  return await new Promise<string>((res, rej) => {
    const deadline = setTimeout(() => rej(new Error(`no inspector url; stderr: ${stderrText}`)), 10_000);
    (async () => {
      for await (const chunk of child.stderr as AsyncIterable<Uint8Array>) {
        stderrText += Buffer.from(chunk).toString('utf8');
        const m = /ws:\/\/[\w.-]+:\d+\/[^\s]+/.exec(stderrText);
        if (m) {
          clearTimeout(deadline);
          res(m[0]);
          return;
        }
      }
    })();
  });
}

test('send() after close rejects fast instead of hanging 10s', async () => {
  // Integration test: deliberately exercises the real request timer against
  // a real socket close, because the rejection speed *is* the behavior under
  // test (the bug was waiting the full 10s timeout).
  const port = await getAvailablePort();
  const child = Bun.spawn(['bun', `--inspect-wait=127.0.0.1:${port}`, server], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  try {
    const url = await scrapeInspectorUrl(child);
    const inspector = new WebSocketInspector(url);
    inspector.on('error', () => {});
    await once(inspector, 'connected');
    expect(inspector.isConnected).toBe(true);

    // Prove the connection is live before tearing it down.
    const evalRes = await inspector.send('Runtime.evaluate', { expression: '1+2', returnByValue: true });
    expect(evalRes.result.value).toBe(3);

    // Attach before close(): the close event can fire synchronously inside
    // ws.close(), which would leave a later once() hanging forever.
    const disconnected = once(inspector, 'disconnected');
    inspector.close();
    await disconnected;
    expect(inspector.isConnected).toBe(false);

    const started = Date.now();
    await expect(inspector.send('Runtime.evaluate', { expression: '1+2' })).rejects.toThrow('closed');
    expect(Date.now() - started, 'send after close must not wait the 10s timeout').toBeLessThan(2_000);
  } finally {
    child.kill();
  }
}, 5000);

test('timed-out request is dropped from the buffered queue', async () => {
  // A TCP server that accepts the connection but never answers the WS
  // handshake keeps the client CONNECTING, so send() queues the frame and
  // only the request timeout can retire it. The 100ms per-instance timeout
  // deliberately exercises the real platform timer (fake timers wedge the
  // bun test worker), and the assertion awaits the rejection, so no extra
  // wall-clock waiting happens.
  const port = await getAvailablePort();
  const tcp = createServer((sock) => {
    sock.on('error', () => {});
    // swallow the upgrade request; never reply
  });
  await new Promise<void>((res) => tcp.listen(port, '127.0.0.1', res));
  const inspector = new WebSocketInspector(`ws://127.0.0.1:${port}/stall`, 100);
  inspector.on('error', () => {});
  await expect(inspector.send('Runtime.evaluate', { expression: '1+2' })).rejects.toThrow('timed out');

  // The stale frame must not linger to flush if the socket opens late.
  // `buffered` is TS-private; this one-off observation of the queue after
  // the timeout handler ran needs a cast — there is no other way in.
  const { buffered } = inspector as unknown as { buffered: string[] };
  expect(buffered).toEqual([]);

  inspector.close();
  tcp.close();
}, 5000);