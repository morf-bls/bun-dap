import { test, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connectStdio, type DapEvent } from './util/framed-client';
import { castObject, hello, serverFixture, launchReady, armBreakpoint } from './util/dap-helpers';
import { getAvailablePort } from '../src/util/port';

// Exercises the control surface the happy-path e2e doesn't: stopOnEntry,
// stepping, pause, terminate, conditional/hit-count breakpoints, function
// breakpoints, exception filters actually pausing, and noDebug runs.
//
// Stopped reasons after steps: JSC pauses with a unified
// PauseOnNextStatement reason for both user `pause` and completed stepping,
// and the adapter reports both as 'pause' (see mapStopReason) — the stepping
// tests below assert that documented mapping.

const repoRoot = resolve(import.meta.dir, '..');

type Client = ReturnType<typeof connectStdio>;

/** initialize + launch (custom args) + wait for `initialized`. */
async function launchWith(client: Client, program: string, extra: Record<string, unknown> = {}) {
  const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
  expect(init.success, init.message).toBe(true);
  const launched = await client.send('launch', {
    program,
    cwd: repoRoot,
    runtime: 'bun',
    stopOnEntry: false,
    noDebug: false,
    ...extra,
  });
  expect(launched.success, launched.message).toBe(true);
  const initialized = await client.waitForEvent('initialized');
  expect(initialized.event).toBe('initialized');
}

/** setExceptionBreakpoints [] + configurationDone (no line breakpoints). */
async function configDone(client: Client): Promise<void> {
  const exc = await client.send('setExceptionBreakpoints', { filters: [] });
  expect(exc.success).toBe(true);
  const done = await client.send('configurationDone', {});
  expect(done.success).toBe(true);
}

/** Launch the server fixture with its own HTTP port and wait until it serves. */
async function launchServer(client: Client): Promise<number> {
  const httpPort = await getAvailablePort();
  await launchWith(client, serverFixture, { env: { PORT: String(httpPort) } });
  await configDone(client);
  return httpPort;
}

/** Bounded reachability probe (mirrors test/attach.test.ts): 'ok' = a request
 * completed, 'paused' = a request connected but never completed (the handler
 * is paused on a breakpoint), 'never' = unreachable. */
async function probe(url: string): Promise<'ok' | 'paused' | 'never'> {
  for (let i = 0; i < 25; i++) {
    try {
      const outcome = await Promise.race([
        fetch(url).then((r) => (r.ok ? 'ok' : 'err')),
        new Promise<'paused'>((res) => setTimeout(() => res('paused'), 400)),
      ]);
      if (outcome === 'ok') return 'ok';
      if (outcome === 'paused') return 'paused';
    } catch {
      // not reachable yet — retry
    }
    await Bun.sleep(100);
  }
  return 'never';
}

test('stopOnEntry: pauses with reason entry before the program body runs', async () => {
  const client = connectStdio();
  try {
    await launchWith(client, hello, { stopOnEntry: true });
    await configDone(client);
    const stopped = await client.waitForEvent('stopped', 10_000);
    expect(castObject(stopped.body).reason).toBe('entry');
    expect(castObject(stopped.body).threadId).toBe(1);
    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);
    const exited = await client.waitForEvent('exited');
    expect(castObject(exited.body).exitCode).toBe(0);
    await client.waitForEvent('terminated');
  } finally {
    client.close();
  }
}, 30_000);

const topOf = async (client: Client): Promise<Record<string, unknown>> => {
  const resp = await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 });
  const frames = castObject(resp.body).stackFrames as Array<Record<string, unknown>>;
  return frames[0] ?? {};
};

test('stepping: next and stepOut move through greet', async () => {
  const client = connectStdio();
  try {
    await launchReady(client, hello);
    await armBreakpoint(client, hello, 2);

    const stopped = await client.waitForEvent('stopped');
    expect(castObject(stopped.body).reason).toBe('breakpoint');

    // next over `const greeting` onto `console.log(greeting)` (TS line 3).
    const nx1 = await client.send('next', { threadId: 1 });
    expect(nx1.success).toBe(true);
    const step1 = await client.waitForEvent('stopped', 10_000);
    expect(castObject(step1.body).reason).toBe('pause'); // step pauses report 'pause'
    const afterNext1 = await topOf(client);
    expect(afterNext1.name).toBe('greet');
    expect(afterNext1.line).toBe(3);

    // next onto `return greeting` (TS line 4).
    const nx2 = await client.send('next', { threadId: 1 });
    expect(nx2.success).toBe(true);
    const step2 = await client.waitForEvent('stopped', 10_000);
    expect(castObject(step2.body).reason).toBe('pause');
    const afterNext2 = await topOf(client);
    expect(afterNext2.name).toBe('greet');
    expect(afterNext2.line).toBe(4);

    // stepOut leaves greet, landing back in the top-level frame at or after
    // the call site (TS line 7; JSC reports the post-call position).
    const so = await client.send('stepOut', { threadId: 1 });
    expect(so.success).toBe(true);
    const step3 = await client.waitForEvent('stopped', 10_000);
    expect(castObject(step3.body).reason).toBe('pause');
    const backOut = await topOf(client);
    expect(backOut.name).not.toBe('greet');
    expect(String(castObject(backOut.source).path)).toEndWith('hello.ts');
    expect(backOut.line).toBeGreaterThanOrEqual(7);

    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);
    const exited = await client.waitForEvent('exited');
    expect(castObject(exited.body).exitCode).toBe(0);
  } finally {
    client.close();
  }
}, 30_000);

test('stepping: stepIn resumes execution and re-stops or finishes', async () => {
  const client = connectStdio();
  try {
    await launchReady(client, hello);
    // Line 7 (`greet('World')`) is a mid-module call — hello.ts ends with a
    // trailing `console.log('done')` because JSC refuses to resolve a
    // deferred breakpoint on a module's *final* statement.
    await armBreakpoint(client, hello, 7);

    const stopped = await client.waitForEvent('stopped');
    expect(castObject(stopped.body).reason).toBe('breakpoint');

    // JSC quirk (verified by raw probe): stepInto paused ON a call statement
    // steps OVER the call instead of entering it, and with only one statement
    // left in the module the step may run the program to its end. The adapter
    // forwards stepInto faithfully; the contract is that the request is
    // accepted, execution resumes, and the session either re-stops or exits.
    const si = await client.send('stepIn', { threadId: 1 });
    expect(si.success).toBe(true);
    const afterStep = await stopOrExit(client);
    let exitCode: unknown;
    if (afterStep.event === 'stopped') {
      expect(castObject(afterStep.body).reason).toBe('pause');
      const frame = await topOf(client);
      expect(frame.name).not.toBe('greet');
      expect(String(castObject(frame.source).path)).toEndWith('hello.ts');
      expect(frame.line).toBeGreaterThanOrEqual(7);
      const cont = await client.send('continue', { threadId: 1 });
      expect(cont.success).toBe(true);
      exitCode = castObject((await client.waitForEvent('exited', 10_000)).body).exitCode;
    } else {
      // The step ran the program to its end; stopOrExit consumed the event.
      exitCode = castObject(afterStep.body).exitCode;
    }
    expect(exitCode).toBe(0);
  } finally {
    client.close();
  }
}, 30_000);

/** Wait for the next `stopped` or `exited` — whichever arrives first. */
async function stopOrExit(client: Client): Promise<DapEvent> {
  return Promise.race([
    client.waitForEvent('stopped', 10_000),
    client.waitForEvent('exited', 10_000),
  ]);
}





test('pause: stops a running program; launch-mode disconnect kills it', async () => {
  const client = connectStdio();
  try {
    const httpPort = await launchServer(client);
    expect(await probe(`http://127.0.0.1:${httpPort}/up`)).toBe('ok');

    const pause = await client.send('pause', { threadId: 1 });
    expect(pause.success).toBe(true);
    // JSC only pauses at the next executed JS statement; an idle Bun.serve
    // event loop never runs JS, so force activity with a request.
    expect(await probe(`http://127.0.0.1:${httpPort}/kick`)).toBe('paused');
    const stopped = await client.waitForEvent('stopped', 10_000);
    expect(castObject(stopped.body).reason).toBe('pause');

    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);

    // Launch-mode disconnect always terminates the debuggee.
    const disc = await client.send('disconnect', {});
    expect(disc.success).toBe(true);
    await client.waitForEvent('exited');
    await client.waitForEvent('terminated');
  } finally {
    client.close();
  }
}, 30_000);

test('terminate: request kills the debuggee', async () => {
  const client = connectStdio();
  try {
    const httpPort = await launchServer(client);
    expect(await probe(`http://127.0.0.1:${httpPort}/up`)).toBe('ok');

    const term = await client.send('terminate', {});
    expect(term.success).toBe(true);
    await client.waitForEvent('exited');
    await client.waitForEvent('terminated');
  } finally {
    client.close();
  }
}, 30_000);

test('conditional breakpoint: a false condition never stops (program exits)', async () => {
  const client = connectStdio();
  try {
    await launchReady(client, hello);
    // The module is gated by --inspect-wait until configurationDone, so the
    // breakpoint verifies via the changed event — armBreakpoint handles both.
    await armBreakpoint(client, hello, 2, { condition: 'name === "Nope"' });
    // If the condition were ignored, the program would pause at line 2 and
    // never exit — the timeout below becomes the failure.
    const exited = await client.waitForEvent('exited', 10_000);
    expect(castObject(exited.body).exitCode).toBe(0);
  } finally {
    client.close();
  }
}, 30_000);

test('conditional breakpoint: a true condition stops', async () => {
  const client = connectStdio();
  try {
    await launchReady(client, hello);
    await armBreakpoint(client, hello, 2, { condition: 'name === "World"' });
    const stopped = await client.waitForEvent('stopped', 10_000);
    expect(castObject(stopped.body).reason).toBe('breakpoint');
    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);
    await client.waitForEvent('exited');
  } finally {
    client.close();
  }
}, 30_000);

test('hitCondition: stops only on the Nth hit', async () => {
  const client = connectStdio();
  try {
    const httpPort = await launchServer(client);
    await armBreakpoint(client, serverFixture, 7, { hitCondition: '2' });
    const url = `http://127.0.0.1:${httpPort}/hit`;
    // Hit 1: count 1 < 2 → auto-resume; the request completes.
    expect(await probe(url)).toBe('ok');
    // Hit 2: count hits the threshold → the handler pauses.
    expect(await probe(url)).toBe('paused');
    const stopped = await client.waitForEvent('stopped', 5_000);
    expect(castObject(stopped.body).reason).toBe('breakpoint');

    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);
    // The paused request completes once the handler resumes; the breakpoint
    // is still armed, so clear it before probing again.
    const clear = await client.send('setBreakpoints', { source: { path: serverFixture }, breakpoints: [] });
    expect(clear.success).toBe(true);
    expect(await probe(url)).toBe('ok');
  } finally {
    client.close();
  }
}, 30_000);

test('function breakpoint stops on function entry', async () => {
  const client = connectStdio();
  try {
    await launchWith(client, hello);
    const set = await client.send('setFunctionBreakpoints', { breakpoints: [{ name: 'greet' }] });
    expect(set.success, set.message).toBe(true);
    await configDone(client);
    const stopped = await client.waitForEvent('stopped', 10_000);
    expect(castObject(stopped.body).reason).toBe('function breakpoint');
    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);
    const exited = await client.waitForEvent('exited');
    expect(castObject(exited.body).exitCode).toBe(0);
  } finally {
    client.close();
  }
}, 30_000);

test('exception filter "all" pauses on a thrown error', async () => {
  const client = connectStdio();
  try {
    await launchWith(client, resolve(repoRoot, 'test/fixtures/throw.ts'));
    const exc = await client.send('setExceptionBreakpoints', { filters: ['all'] });
    expect(exc.success).toBe(true);
    const done = await client.send('configurationDone', {});
    expect(done.success).toBe(true);
    const stopped = await client.waitForEvent('stopped', 10_000);
    const body = castObject(stopped.body);
    expect(body.reason).toBe('exception');
    expect(String(body.exceptionText)).toContain('boom');
    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);
    await client.waitForEvent('exited');
    await client.waitForEvent('terminated');
  } finally {
    client.close();
  }
}, 30_000);

test('noDebug: runs without an inspector, inspection requests degrade gracefully', async () => {
  const client = connectStdio();
  try {
    const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(init.success).toBe(true);
    // noDebug spawns without an inspector: no `initialized` event ever
    // arrives; the process runs straight to completion.
    const launched = await client.send('launch', {
      program: hello,
      cwd: repoRoot,
      runtime: 'bun',
      stopOnEntry: false,
      noDebug: true,
    });
    expect(launched.success, launched.message).toBe(true);
    const exited = await client.waitForEvent('exited', 10_000);
    expect(castObject(exited.body).exitCode).toBe(0);
    await client.waitForEvent('terminated');

    const st = await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 });
    const frames = castObject(st.body).stackFrames;
    expect(Array.isArray(frames) && frames.length).toBe(0);
    const threads = await client.send('threads', {});
    expect(castObject(threads.body).threads).toEqual([{ id: 1, name: 'main' }]);
  } finally {
    client.close();
  }
}, 30_000);

test('breakpoints resolve through a symlinked program path', async () => {
  // Bun reports inspector script URLs with symlinks canonicalized (macOS
  // /tmp → /private/tmp), so a client path through a symlink must be
  // realpath'd before it can match the script and arm a JSC breakpoint.
  // Regression: without the canonicalization, the deferred bp never resolves
  // (verified stays false) and the program runs to exit without stopping.
  const linkDir = mkdtempSync(join(tmpdir(), 'bun-dap-link-'));
  const linkedHello = join(linkDir, 'hello.ts');
  symlinkSync(hello, linkedHello);
  const client = connectStdio();
  try {
    await launchReady(client, linkedHello);
    await armBreakpoint(client, linkedHello, 2);
    const stopped = await client.waitForEvent('stopped', 10_000);
    expect(castObject(stopped.body).reason).toBe('breakpoint');
    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);
    const exited = await client.waitForEvent('exited');
    expect(castObject(exited.body).exitCode).toBe(0);
  } finally {
    client.close();
    rmSync(linkDir, { recursive: true, force: true });
  }
}, 30_000);
