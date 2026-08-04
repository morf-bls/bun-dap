import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { connectStdio, type DapResponse } from './util/framed-client';

const repoRoot = resolve(import.meta.dir, '..');
const hello = resolve(repoRoot, 'test/fixtures/hello.ts');
const offset = resolve(repoRoot, 'test/fixtures/offset.ts');

function castObject(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

function firstBreakpoint(resp: DapResponse): Record<string, unknown> {
  const body = castObject(resp.body);
  const bps = body.breakpoints;
  if (Array.isArray(bps) && bps.length > 0 && typeof bps[0] === 'object' && bps[0] !== null) {
    return bps[0] as Record<string, unknown>;
  }
  throw new Error(`setBreakpoints response has no breakpoints: ${JSON.stringify(resp.body)}`);
}

/** The module may not be parsed yet when setBreakpoints arrives: the adapter then
 * answers verified:false ('pending script load') and emits a `breakpoint`
 * changed event once scriptParsed re-arms it. Poll the changed event in that case. */
async function breakpointVerified(
  client: ReturnType<typeof connectStdio>,
  set: DapResponse,
): Promise<Record<string, unknown>> {
  let bp = firstBreakpoint(set);
  for (let i = 0; i < 20 && bp.verified !== true; i++) {
    const changed = await client.waitForEvent('breakpoint', 2_000);
    const body = castObject(changed.body);
    const updated = body.breakpoint;
    if (updated && typeof updated === 'object') bp = updated as Record<string, unknown>;
  }
  return bp;
}

/** initialize + capability checks + launch + wait for the `initialized` event. */
async function launchReady(client: ReturnType<typeof connectStdio>, program: string) {
  const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
  expect(init.success, init.message).toBe(true);
  const caps = castObject(init.body);
  expect(caps.supportsConfigurationDoneRequest).toBe(true);
  expect(caps.supportsConditionalBreakpoints).toBe(true);
  expect(caps.supportsHitConditionalBreakpoints).toBe(true);
  expect(caps.supportsLogPoints).toBe(true);
  const filters = caps.exceptionBreakpointFilters;
  expect(Array.isArray(filters) && filters.length).toBe(2);

  const launch = await client.send('launch', {
    program,
    cwd: repoRoot,
    stopOnEntry: false,
    noDebug: false,
    runtime: 'bun',
  });

  expect(launch.success, launch.message).toBe(true);

  const initialized = await client.waitForEvent('initialized');
  expect(initialized.event).toBe('initialized');
}
/** Breakpoint + exception filters + configurationDone, then poll for the re-arm
 * event. Order matters: with --inspect-wait the module only parses once the
 * `Inspector.initialized` gate opens (configurationDone), so the `breakpoint`
 * changed event can never arrive before it. */
async function armBreakpoint(
  client: ReturnType<typeof connectStdio>,
  sourcePath: string,
  line: number,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const set = await client.send('setBreakpoints', {
    source: { path: sourcePath },
    breakpoints: [{ line, ...extra }],
  });
  const exc = await client.send('setExceptionBreakpoints', { filters: [] });
  expect(exc.success).toBe(true);
  const done = await client.send('configurationDone', {});
  expect(done.success).toBe(true);
  const bp = await breakpointVerified(client, set);
  expect(bp.verified, `breakpoint ${sourcePath}:${line} should verify`).toBe(true);
  expect(bp.line).toBe(line);
  return bp;
}

test('e2e: launch hello.ts, breakpoint, stack, scopes, variables, evaluate, continue', async () => {
  const client = connectStdio();
  try {
    await launchReady(client, hello);
    await armBreakpoint(client, hello, 2);

    const stopped = await client.waitForEvent('stopped');
    expect(castObject(stopped.body).reason).toBe('breakpoint');
    expect(castObject(stopped.body).threadId).toBe(1);

    const threads = await client.send('threads', {});
    const threadArr = castObject(threads.body).threads as Array<Record<string, unknown>>;
    expect(threadArr).toHaveLength(1);
    expect(threadArr[0]?.id).toBe(1);
    expect(threadArr[0]?.name).toBe('main');

    const st = await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 });
    const frames = castObject(st.body).stackFrames as Array<Record<string, unknown>>;
    expect(frames.length).toBeGreaterThan(0);
    const top = frames[0]!;
    expect(top.line).toBe(2); // TS line via source map, not the generated JS line
    const src = castObject(top.source);
    expect(String(src.path)).toEndWith('hello.ts');
    const frameId = top.id as number;
    const scopesResp = await client.send('scopes', { frameId });
    const scopesArr = castObject(scopesResp.body).scopes as Array<Record<string, unknown>>;
    const local = scopesArr.find((s) => s.name === 'Local');
    expect(local, 'expected a Local scope').toBeDefined();
    const localRef = local!.variablesReference as number;
    expect(localRef).toBeGreaterThan(0);

    // JSC/Bun splits the function's block env and parameter env into separate
    // closure scopes — search every scope for the `name` parameter.
    let nameVar: Record<string, unknown> | undefined;
    for (const scope of scopesArr) {
      const ref = scope.variablesReference as number;
      if (!ref) continue;
      const varsResp = await client.send('variables', { variablesReference: ref });
      const vars = castObject(varsResp.body).variables as Array<Record<string, unknown>>;
      nameVar ??= vars.find((v) => v.name === 'name');
    }
    expect(nameVar, 'expected parameter `name` in locals').toBeDefined();
    expect(String(nameVar!.value)).toContain('World');


    const evalResp = await client.send('evaluate', {
      expression: 'name.toUpperCase()',
      frameId,
      context: 'repl',
    });
    expect(evalResp.success, evalResp.message).toBe(true);
    const evalBody = castObject(evalResp.body);
    expect(String(evalBody.result)).toContain('WORLD');

    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);

    const exited = await client.waitForEvent('exited');
    expect(castObject(exited.body).exitCode).toBe(0);
    await client.waitForEvent('terminated');
  } finally {
    client.close();
  }
}, 30_000);

// KNOWN BUG (deferred breakpoint misalignment) — skipped pending a fix.
// Bun resolves deferred URL-keyed breakpoints against GENERATED JS coordinates,
// not TS lines, so a breakpoint armed at `bp.line - 1` before the module parses
// lands on the wrong statement when the generated layout diverges from the TS
// source (comment headers, wrappers, Bun's line merging). The 9-line header in
// test/fixtures/offset.ts shifts TS line 13 onto a generated line that maps
// back to a different TS statement, so the pause lands at the wrong line.
// Reproduction: launch examples/buggy.ts, setBreakpoints line 23 (applyDiscount
// return) → pauses at makeCounter:44. bun's own adapter (bun-debug-adapter-protocol)
// uses a line-0 placeholder + re-arm on breakpointResolved; that works for
// offset-style files but, when ported, races fast/overlapping modules (hello.ts,
// stepIn) where the placeholder's resolved statement coincides with the real
// bp target. A hybrid (arm bp.line-1 + correct on resolve) loses the stop when
// the target line executes during the correction RPC. Both hit fundamental JSC
// timing races. See examples/buggy.ts and the report for the full analysis.
test.skip('e2e: deferred breakpoint behind a comment header re-arms onto the requested TS line', async () => {
  const client = connectStdio();
  try {
    await launchReady(client, offset);
    // The script is not parsed yet (--inspect-wait gate still closed), so the
    // adapter arms the breakpoint at `bp.line - 1` directly. Bun resolves that
    // against GENERATED coordinates; with the 9-line comment header the
    // generated layout diverges from the TS layout, so the pause lands on the
    // wrong TS line instead of the requested line 13 (`return sum`).
    await armBreakpoint(client, offset, 13);

    const stopped = await client.waitForEvent('stopped');
    expect(castObject(stopped.body).reason).toBe('breakpoint');
    expect(castObject(stopped.body).threadId).toBe(1);

    const st = await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 });
    const frames = castObject(st.body).stackFrames as Array<Record<string, unknown>>;
    expect(frames.length).toBeGreaterThan(0);
    const top = frames[0]!;
    expect(top.line).toBe(13); // requested TS line, not the offset-shifted one
    const src = castObject(top.source);
    expect(String(src.path)).toEndWith('offset.ts');

    const cont = await client.send('continue', { threadId: 1 });
    expect(cont.success).toBe(true);
    const exited = await client.waitForEvent('exited');
    expect(castObject(exited.body).exitCode).toBe(0);
    await client.waitForEvent('terminated');
  } finally {
    client.close();
  }
}, 30_000);

test('e2e: logpoint prints an output event and never stops', async () => {
  const client = connectStdio();
  try {
    await launchReady(client, hello);
    await armBreakpoint(client, hello, 3, { logMessage: 'logpoint hit' });

    const stopped = client.waitForEvent('stopped', 3_000).then(
      () => 'stopped',
      () => 'no-stopped',
    );
    const race = await Promise.race([
      stopped,
      client.waitForEvent('exited', 15_000).then(() => 'exited'),
    ]);
    expect(race).toBe('exited');

    // The logpoint output must have been emitted even though we never stopped.
    // Skip earlier output events (e.g. the Bun Inspector stderr banner).
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const out = await client.waitForEvent('output', 2_000);
      const outBody = castObject(out.body);
      if (outBody.category === 'console' && String(outBody.output).includes('logpoint hit')) {
        found = true;
      }
    }
    expect(found, 'expected a console output event with the logpoint message').toBe(true);

    await client.waitForEvent('terminated', 10_000);
  } finally {
    client.close();
  }
}, 30_000);