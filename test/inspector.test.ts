import { test, expect } from 'bun:test';
import { getAvailablePort } from '../src/util/port';
import { WebSocketInspector } from '../src/inspector/websocket-inspector';
import { once } from 'node:events';
import { resolve } from 'node:path';

const server = resolve(import.meta.dir, 'fixtures/server.ts');

test('WebSocketInspector drives bun --inspect-wait', async () => {
  const port = await getAvailablePort();
  const child = Bun.spawn(['bun', `--inspect-wait=127.0.0.1:${port}`, server], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  try {
    // Scrape the ws:// URL off stderr (banner form: ws://127.0.0.1:PORT/UUID).
    let stderrText = '';
    const url = await new Promise<string>((res, rej) => {
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

    const inspector = new WebSocketInspector(url);
    inspector.on('error', () => {});
    await once(inspector, 'connected');

    const scriptParsed = new Promise<{ url: string }>((res) => inspector.on('Debugger.scriptParsed', res));
    await inspector.send('Runtime.enable');
    await inspector.send('Debugger.enable');
    // Release the --inspect-wait gate (the adapter does this in configurationDone).
    await inspector.send('Inspector.initialized');

    const sp = await scriptParsed;
    expect(sp.url).toEndWith('server.ts');

    const evalRes = await inspector.send('Runtime.evaluate', { expression: '1+2', returnByValue: true });
    expect(evalRes.result.value).toBe(3);

    inspector.close();
  } finally {
    child.kill();
  }
}, 20000);
