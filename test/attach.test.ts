import { test, expect } from 'bun:test';
import { connectStdio } from './util/framed-client';
import { getAvailablePort } from '../src/util/port';
import { castObject, hello, serverFixture, armBreakpoint } from './util/dap-helpers';

// Integration exception to the no-timers rule: the server is a real spawned
// process whose bind/response timing is not under deterministic control, so
// the probe polls with short bounded timeouts instead of fake timers.

/** Fire requests until the server is reachable. Returns:
 * - 'ok': a request completed with a response (breakpoint did NOT pause),
 * - 'paused': a request connected but never completed (handler is paused),
 * - 'never': the server never became reachable. */
async function probeServer(url: string): Promise<'ok' | 'paused' | 'never'> {
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return 'ok';
    } catch (err) {
      const e = err as Error & { name?: string };
      if (e.name === 'TimeoutError') return 'paused'; // connected, handler stuck on the bp
      // otherwise connection refused — server not bound yet
    }
    await Bun.sleep(200);
  }
  return 'never';
}
test('e2e: attach to a running server, breakpoint on a request, disconnect keeps it alive', async () => {
  const httpPort = await getAvailablePort();
  const inspectPort = await getAvailablePort();
  const child = Bun.spawn(['bun', `--inspect-wait=127.0.0.1:${inspectPort}`, serverFixture], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, PORT: String(httpPort) },
  });
  let stderrText = '';
  const url = await new Promise<string>((res, rej) => {
    const deadline = setTimeout(() => rej(new Error(`no inspector url; stderr: ${stderrText}`)), 10_000);
    void (async () => {
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

  const client = connectStdio();
  try {
    const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(init.success, init.message).toBe(true);

    const attach = await client.send('attach', { url });
    expect(attach.success, attach.message).toBe(true);
    expect((await client.waitForEvent('initialized')).event).toBe('initialized');

    // Break on the fetch handler's console.log (TS line 7). The module has not
    // parsed yet (--inspect-wait gate), so this arms the native deferred bp.
    await armBreakpoint(client, serverFixture, 7);

    // Gate released at configurationDone: the server is now bound and will
    // pause on the first request.

    // The first request pauses the handler on the breakpoint, so the probe
    // reports 'paused' (request connected but never completed).
    expect(await probeServer(`http://127.0.0.1:${httpPort}/ping`)).toBe('paused');

    const stopped = await client.waitForEvent('stopped', 5_000);
    expect(castObject(stopped.body).reason).toBe('breakpoint');
    expect(castObject(stopped.body).threadId).toBe(1);

    const st = await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 });
    const frames = castObject(st.body).stackFrames as Array<Record<string, unknown>>;
    expect(frames.length).toBeGreaterThan(0);
    const src = castObject(frames[0]!.source);
    expect(String(src.path)).toEndWith('server.ts');

    // Resume so the handler completes; the server keeps serving afterwards.
    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);

    // Every request pauses at line 7 — clear the breakpoint so the next
    // request completes (also exercises breakpoint removal).
    const clear = await client.send('setBreakpoints', { source: { path: serverFixture }, breakpoints: [] });
    expect(clear.success).toBe(true);
    expect(await probeServer(`http://127.0.0.1:${httpPort}/after`)).toBe('ok');

    // Detach (attach mode: the debuggee is NOT terminated).
    const disc = await client.send('disconnect', {});
    expect(disc.success).toBe(true);
    expect(child.exitCode).toBeNull(); // server survived the detach

    // Still serving after the adapter is gone.
    expect(await probeServer(`http://127.0.0.1:${httpPort}/still-up`)).toBe('ok');

  } finally {
    client.close();
    child.kill();
  }
}, 30_000);

test('e2e: attach to a garbage ws url fails fast instead of hanging', async () => {
  const client = connectStdio();
  try {
    const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(init.success, init.message).toBe(true);
    // Port 1 (tcpmux) is refused on loopback: the WebSocket errors before
    // opening. A regression to `once('connected')` makes this request hang
    // until the client's own 10 s timeout — the fix must answer promptly.
    const attach = await client.send('attach', { url: 'ws://127.0.0.1:1/not-a-debugger' });
    expect(attach.success, attach.message).toBe(false);
    expect(String(attach.message)).toContain('could not connect');
  } finally {
    client.close();
  }
}, 30_000);

test('e2e: attach disconnect with terminateDebuggee kills the target', async () => {
  const httpPort = await getAvailablePort();
  const inspectPort = await getAvailablePort();
  const child = Bun.spawn(['bun', `--inspect-wait=127.0.0.1:${inspectPort}`, serverFixture], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, PORT: String(httpPort) },
  });
  const client = connectStdio();
  try {
    const url = await scrapeInspectorUrl(child);
    const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(init.success, init.message).toBe(true);
    const attach = await client.send('attach', { url });
    expect(attach.success, attach.message).toBe(true);
    await client.waitForEvent('initialized');

    // Release the --inspect-wait gate so the debuggee actually runs.
    const exc = await client.send('setExceptionBreakpoints', { filters: [] });
    expect(exc.success).toBe(true);
    const done = await client.send('configurationDone', {});
    expect(done.success).toBe(true);
    expect(await probeServer(`http://127.0.0.1:${httpPort}/up`)).toBe('ok');

    // terminateDebuggee: true must kill the attached process (resolved via
    // process.pid over the inspector), unlike a plain detach.
    const disc = await client.send('disconnect', { terminateDebuggee: true });
    expect(disc.success, disc.message).toBe(true);
    await Promise.race([
      child.exited,
      Bun.sleep(10_000).then(() => {
        throw new Error('attached target survived terminateDebuggee');
      }),
    ]);
    expect(await probeServer(`http://127.0.0.1:${httpPort}/dead`)).toBe('never');
  } finally {
    client.close();
    child.kill();
  }
}, 30_000);

test('e2e: B2b attach-mode terminate request kills the target', async () => {
  // M6 regression guard: the `terminate` request (not disconnect) in attach
  // mode must kill the attached target. adapter-control.test.ts:301 sends
  // `terminate` in launch mode; the test above sends disconnect with
  // terminateDebuggee in attach mode. Neither hits the exact path: terminate
  // request → attach mode → kill target.
  const httpPort = await getAvailablePort();
  const inspectPort = await getAvailablePort();
  const child = Bun.spawn(['bun', `--inspect-wait=127.0.0.1:${inspectPort}`, serverFixture], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, PORT: String(httpPort) },
  });
  const client = connectStdio();
  try {
    const url = await scrapeInspectorUrl(child);
    const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(init.success, init.message).toBe(true);
    const attach = await client.send('attach', { url });
    expect(attach.success, attach.message).toBe(true);
    await client.waitForEvent('initialized');

    // Release the --inspect-wait gate so the debuggee actually runs.
    const exc = await client.send('setExceptionBreakpoints', { filters: [] });
    expect(exc.success).toBe(true);
    const done = await client.send('configurationDone', {});
    expect(done.success).toBe(true);
    expect(await probeServer(`http://127.0.0.1:${httpPort}/up`)).toBe('ok');

    // The `terminate` request (not disconnect) in attach mode must kill the
    // attached process via process.pid resolved over the inspector.
    const term = await client.send('terminate', {});
    expect(term.success, term.message).toBe(true);
    await Promise.race([
      child.exited,
      Bun.sleep(10_000).then(() => {
        throw new Error('attached target survived terminate request');
      }),
    ]);
    expect(await probeServer(`http://127.0.0.1:${httpPort}/dead`)).toBe('never');
  } finally {
    client.close();
    child.kill();
  }
}, 30_000);

test('e2e: attach mode emits exited+terminated when the debuggee exits', async () => {
  // hello.ts runs to completion on its own. Attach mode has no child
  // handle, so the inspector socket close is the only exit signal — a
  // regression here leaves the client session open forever (nvim log:
  // final continue, then nothing; session never closed).
  const inspectPort = await getAvailablePort();
  const child = Bun.spawn(['bun', `--inspect-wait=127.0.0.1:${inspectPort}`, hello], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const url = await scrapeInspectorUrl(child);
  const client = connectStdio();
  try {
    const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(init.success, init.message).toBe(true);
    const attach = await client.send('attach', { url });
    expect(attach.success, attach.message).toBe(true);
    await client.waitForEvent('initialized');
    await client.send('setExceptionBreakpoints', { filters: [] });
    const done = await client.send('configurationDone', {});
    expect(done.success).toBe(true);

    // No breakpoints: the program runs to completion. The adapter must emit
    // exited then terminated — nvim-dap closes the session on terminated.
    const exited = await client.waitForEvent('exited', 10_000);
    expect(castObject(exited.body).exitCode).toBe(0);
    await client.waitForEvent('terminated', 5_000);
  } finally {
    client.close();
    child.kill();
  }
}, 30_000);

/** Scrape the ws:// inspector URL off the child's stderr (10 s deadline). */
async function scrapeInspectorUrl(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  let stderrText = '';
  const url = await new Promise<string>((res, rej) => {
    const deadline = setTimeout(() => rej(new Error(`no inspector url; stderr: ${stderrText}`)), 10_000);
    void (async () => {
      for await (const chunk of child.stderr as AsyncIterable<Uint8Array>) {
        stderrText += Buffer.from(chunk).toString('utf8');
        const m = /ws:\/\/[\w.-]+:\d+\/[^\s]+/.exec(stderrText);
        if (m) {
          clearTimeout(deadline);
          res(m[0]);
          return;
        }
      }
      clearTimeout(deadline);
      rej(new Error(`child stderr ended without an inspector url; stderr: ${stderrText}`));
    })();
  });
  return url;
}