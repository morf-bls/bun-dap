import { must } from './util/dap-helpers';
import { type DapResponse, connectStdio } from './util/framed-client';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

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
    set: DapResponse
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
    extra: Record<string, unknown> = {}
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
        const threadArr = castObject(threads.body).threads as Record<string, unknown>[];
        expect(threadArr).toHaveLength(1);
        expect(threadArr[0]?.id).toBe(1);
        expect(threadArr[0]?.name).toBe('main');

        const st = await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 });
        const frames = castObject(st.body).stackFrames as Record<string, unknown>[];
        expect(frames.length).toBeGreaterThan(0);
        const top = must(frames[0]);
        expect(top.line).toBe(2); // TS line via source map, not the generated JS line
        const src = castObject(top.source);
        expect(String(src.path)).toEndWith('hello.ts');
        const frameId = top.id as number;
        const scopesResp = await client.send('scopes', { frameId });
        const scopesArr = castObject(scopesResp.body).scopes as Record<string, unknown>[];
        const local = scopesArr.find((s) => s.name === 'Local');
        expect(local, 'expected a Local scope').toBeDefined();
        const localRef = must(local).variablesReference as number;
        expect(localRef).toBeGreaterThan(0);

        // JSC/Bun splits the function's block env and parameter env into separate
        // closure scopes — search every scope for the `name` parameter.
        let nameVar: Record<string, unknown> | undefined;
        for (const scope of scopesArr) {
            const ref = scope.variablesReference as number;
            if (!ref) continue;
            const varsResp = await client.send('variables', { variablesReference: ref });
            const vars = castObject(varsResp.body).variables as Record<string, unknown>[];
            nameVar ??= vars.find((v) => v.name === 'name');
        }
        expect(nameVar, 'expected parameter `name` in locals').toBeDefined();
        expect(String(must(nameVar).value)).toContain('World');

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

test('e2e: stackTrace without levels returns all frames (nvim-dap omits it)', async () => {
    const client = connectStdio();
    try {
        await launchReady(client, hello);
        await armBreakpoint(client, hello, 2);
        await client.waitForEvent('stopped');
        // DAP: a missing `levels` means "return all frames". nvim-dap omits it
        // (VS Code pages explicitly); a session-layer `?? 0` default once made
        // this return zero frames with totalFrames > 0, which nvim renders as
        // "stopped at unavailable location".
        const st = await client.send('stackTrace', { threadId: 1, startFrame: 0 });
        const body = castObject(st.body);
        const frames = body.stackFrames as Record<string, unknown>[];
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.length).toBe(body.totalFrames as number);
        expect(frames[0]?.line).toBe(2);
        const cont = await client.send('continue', { threadId: 1 });
        expect(cont.success).toBe(true);
        await client.waitForEvent('exited');
    } finally {
        client.close();
    }
}, 30_000);

// Regression test for the deferred-breakpoint misalignment (fixed): Bun
// resolves URL-keyed breakpoints against GENERATED JS coordinates, not TS
// lines. setBreakpoints used to arm deferred (pre-parse) bps at `bp.line - 1`
// — a TS line treated as a generated line — which lands on the wrong statement
// as soon as the generated layout diverges from the TS source (the 9-line
// comment header below, or Bun's statement merging/inlining accumulating
// across a file). The fix defers the arm to the source's scriptParsed (whose
// map is decoded synchronously, matching bun's own bun-debug-adapter-protocol)
// and freezes the VM with a one-shot pre-gate Debugger.pause so the mapped
// arm always lands before the module body runs; if the bp's target IS that
// first executed statement, the brake's pause stands in for the hit.
test('e2e: deferred breakpoint behind a comment header re-arms onto the requested TS line', async () => {
    const client = connectStdio();
    try {
        await launchReady(client, offset);
        // offset.ts has a 9-line comment header; line 13 is `return sum`.
        await armBreakpoint(client, offset, 13);

        const stopped = await client.waitForEvent('stopped');
        expect(castObject(stopped.body).reason).toBe('breakpoint');
        expect(castObject(stopped.body).threadId).toBe(1);

        const st = await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 });
        const frames = castObject(st.body).stackFrames as Record<string, unknown>[];
        expect(frames.length).toBeGreaterThan(0);
        const top = must(frames[0]);
        expect(top.line).toBe(13); // requested TS line, not the offset-shifted one
        expect(top.name).toBe('add');
        const src = castObject(top.source);
        expect(String(src.path)).toEndWith('offset.ts');

        // bp 13 sits inside add, which main calls twice: the correctly placed
        // breakpoint must fire on BOTH passes, each time at the requested line.
        const cont = await client.send('continue', { threadId: 1 });
        expect(cont.success).toBe(true);
        const stopped2 = await client.waitForEvent('stopped');
        expect(castObject(stopped2.body).reason).toBe('breakpoint');
        const frames2 = castObject((await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 })).body)
            .stackFrames as Record<string, unknown>[];
        expect(frames2[0]?.line).toBe(13);
        expect(frames2[0]?.name).toBe('add');
        const cont2 = await client.send('continue', { threadId: 1 });
        expect(cont2.success).toBe(true);

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
            () => 'no-stopped'
        );
        const race = await Promise.race([stopped, client.waitForEvent('exited', 15_000).then(() => 'exited')]);
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
