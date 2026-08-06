import { getAvailablePort } from '../src/util/port';
import { armBreakpoint, castObject, hello, importsFixture, launchReady, serverFixture } from './util/dap-helpers';
import { connectStdio } from './util/framed-client';
import { expect, test } from 'bun:test';

// e2e verifications ported from the 2026-08 nvim-dap debugging session's ad
// hoc probes. They cover the flows the unit-oriented suites did not:
//   - deferred breakpoints in a module WITH imports (the nvim attach
//     failure: bp verified but never hit — the global brake fires in a
//     builtin initializer before the entry module parses, and the sync body
//     outruns the arm RPC without the per-source placeholder brake)
//   - stopOnEntry combined with a deferred bp on the entry file (entry bp
//     and line-0 placeholder dedupe)
//   - attach-mode stepping and variable inspection at every stop
//   - exited/terminated emission exactly once in launch mode
//   - a manual pause after stepping reporting 'pause' (step flag consumed)
//
// Fixture line map (test/fixtures/imports.ts):
//   11  function compute(i: number): number {
//   12    const p = nodePath.join('/tmp', `case-${i}`);   <- placeholder snaps here
//   13    return p.length + i;                            <- bp target (non-alias)
//   18    total += compute(i);                            <- step-out landing

type Client = ReturnType<typeof connectStdio>;

const BP_LINE = 13;

/** stackTrace top frame (shorthand matching adapter-control.test.ts). */
const topOf = async (client: Client): Promise<Record<string, unknown>> => {
    const resp = await client.send('stackTrace', { threadId: 1, startFrame: 0, levels: 10 });
    const frames = castObject(resp.body).stackFrames as Record<string, unknown>[];
    return frames[0] ?? {};
};

/** Fetch every scope's variables at the current stop; fail on any error
 * (the post-step -32000 regression) and require at least one variable. */
async function expectVariablesPresent(client: Client, frameId: unknown): Promise<void> {
    const sc = await client.send('scopes', { frameId });
    const scopes = castObject(sc.body).scopes as Record<string, unknown>[];
    expect(scopes.length).toBeGreaterThan(0);
    let total = 0;
    for (const scope of scopes) {
        const ref = scope.variablesReference as number;
        if (ref <= 0) continue;
        const vars = await client.send('variables', { variablesReference: ref });
        expect(vars.success, vars.message).toBe(true);
        total += (castObject(vars.body).variables as unknown[]).length;
    }
    expect(total).toBeGreaterThan(0);
}

/** Spawn a fixture under --inspect-wait and scrape the ws URL (10 s deadline). */
async function spawnInspectable(program: string): Promise<{ child: ReturnType<typeof Bun.spawn>; url: string }> {
    const inspectPort = await getAvailablePort();
    const child = Bun.spawn(['bun', `--inspect-wait=127.0.0.1:${inspectPort}`, program], {
        cwd: import.meta.dir,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
    });
    let stderrText = '';
    const url = await new Promise<string>((res, rej) => {
        const deadline = setTimeout(() => {
            rej(new Error(`no inspector url; stderr: ${stderrText}`));
        }, 10_000);
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
    return { child, url };
}

test('e2e: launch a module with imports — deferred bp stops at the exact line', async () => {
    const client = connectStdio();
    try {
        await launchReady(client, importsFixture);
        await armBreakpoint(client, importsFixture, BP_LINE);
        // Pre-placeholder-brake behavior: the bp verified but the program ran to
        // completion without stopping (the brake fired inside node:path's
        // initializer and the sync body outran the arm).
        const stopped = await client.waitForEvent('stopped', 10_000);
        expect(castObject(stopped.body).reason).toBe('breakpoint');
        const top = await topOf(client);
        expect(top.line).toBe(BP_LINE);
        expect(String(castObject(top.source).path)).toEndWith('imports.ts');
        // The bp re-hits every loop iteration; clear it BEFORE continuing so the
        // program runs to completion.
        await client.send('setBreakpoints', { source: { path: importsFixture }, breakpoints: [] });
        const cont = await client.send('continue', { threadId: 1 });
        expect(cont.success).toBe(true);
        await client.waitForEvent('exited', 10_000);
    } finally {
        client.close();
    }
}, 30_000);

test('e2e: attach a module with imports — deferred bp stops at the exact line', async () => {
    // The exact nvim-dap failure flow: bun --inspect-wait running the target,
    // attach, bp, configurationDone — bp must verify AND hit.
    const { child, url } = await spawnInspectable(importsFixture);
    const client = connectStdio();
    try {
        const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
        expect(init.success, init.message).toBe(true);
        const attach = await client.send('attach', { url });
        expect(attach.success, attach.message).toBe(true);
        await client.waitForEvent('initialized');
        await armBreakpoint(client, importsFixture, BP_LINE);

        const stopped = await client.waitForEvent('stopped', 10_000);
        expect(castObject(stopped.body).reason).toBe('breakpoint');
        const top = await topOf(client);
        expect(top.line).toBe(BP_LINE);
        expect(String(castObject(top.source).path)).toEndWith('imports.ts');
        await client.send('disconnect', { terminateDebuggee: true });
    } finally {
        client.close();
        child.kill();
    }
}, 30_000);

test('e2e: stopOnEntry with a deferred bp — entry stop first, bp stop on continue', async () => {
    // stopOnEntry + Path B on the same file: the entry bp and the line-0
    // placeholder both target line 0; JSC rejects a duplicate, so the adapter
    // reuses the placeholder as the entry bp. A regression strands
    // firstPausePending and mislabels the bp stop as 'entry'.
    const client = connectStdio();
    try {
        const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
        expect(init.success, init.message).toBe(true);
        const launch = await client.send('launch', {
            program: importsFixture,
            cwd: import.meta.dir,
            stopOnEntry: true,
            noDebug: false,
            runtime: 'bun',
        });
        expect(launch.success, launch.message).toBe(true);
        await client.waitForEvent('initialized');
        await armBreakpoint(client, importsFixture, BP_LINE);

        const entryStop = await client.waitForEvent('stopped', 10_000);
        expect(castObject(entryStop.body).reason).toBe('entry');
        expect(castObject(entryStop.body).hitBreakpointIds ?? []).toEqual([]);

        const cont = await client.send('continue', { threadId: 1 });
        expect(cont.success).toBe(true);
        const bpStop = await client.waitForEvent('stopped', 10_000);
        expect(castObject(bpStop.body).reason).toBe('breakpoint');
        const top = await topOf(client);
        expect(top.line).toBe(BP_LINE);

        await client.send('setBreakpoints', { source: { path: importsFixture }, breakpoints: [] });
        await client.send('continue', { threadId: 1 });
        await client.waitForEvent('exited', 10_000);
    } finally {
        client.close();
    }
}, 30_000);

test('e2e: attach stepping — next reports step at consecutive lines, variables present at every stop', async () => {
    // Ported from the session's vars/step probes: after each next the stopped
    // reason must be 'step' (nvim only moves the cursor for 'step'), the top
    // frame must advance, and every scope's variables must fetch cleanly
    // (the -32000 regression made them vanish after steps).
    const { child, url } = await spawnInspectable(importsFixture);
    const client = connectStdio();
    try {
        const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
        expect(init.success, init.message).toBe(true);
        const attach = await client.send('attach', { url });
        expect(attach.success, attach.message).toBe(true);
        await client.waitForEvent('initialized');
        await armBreakpoint(client, importsFixture, 12);

        const bpStop = await client.waitForEvent('stopped', 10_000);
        expect(castObject(bpStop.body).reason).toBe('breakpoint');
        const atBp = await topOf(client);
        expect(atBp.line).toBe(12);
        // Clients fetch all scopes at every stop; pause-1 fetches are what made
        // the stale-ref regression bite, so do exactly that here.
        await expectVariablesPresent(client, atBp.id);

        // next: line 12 -> 13 (inside compute).
        await client.send('next', { granularity: 'statement', threadId: 1 });
        const step1 = await client.waitForEvent('stopped', 10_000);
        expect(castObject(step1.body).reason).toBe('step');
        const afterNext1 = await topOf(client);
        expect(afterNext1.line).toBe(13);
        await expectVariablesPresent(client, afterNext1.id);

        // next: line 13 returns from compute. Clear the bp first — the loop
        // re-enters compute every iteration, and a bp hit mid-step cancels the
        // step (the stop would report 'breakpoint', not 'step'). JSC reports the
        // post-return position as the caller's line; assert the contract that
        // matters here (reason + variables), the exact line is engine-specific.
        await client.send('setBreakpoints', { source: { path: importsFixture }, breakpoints: [] });
        await client.send('next', { granularity: 'statement', threadId: 1 });
        const step2 = await client.waitForEvent('stopped', 10_000);
        expect(castObject(step2.body).reason).toBe('step');
        const afterNext2 = await topOf(client);
        expect(afterNext2.line).toBeGreaterThan(0);
        await expectVariablesPresent(client, afterNext2.id);

        await client.send('disconnect', { terminateDebuggee: true });
    } finally {
        client.close();
        child.kill();
    }
}, 30_000);

test('e2e: launch mode emits exited and terminated exactly once', async () => {
    // The exit events route through a dedup flag (child exit vs inspector
    // disconnect); a double emission confuses clients' session teardown.
    const client = connectStdio();
    try {
        await launchReady(client, hello);
        const done = await client.send('configurationDone', {});
        expect(done.success).toBe(true);

        let exited = 0;
        let terminated = 0;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
            try {
                const ev = await Promise.race([
                    client.waitForEvent('exited', 500),
                    client.waitForEvent('terminated', 500),
                ]);
                if (ev.event === 'exited') exited++;
                if (ev.event === 'terminated') terminated++;
                if (terminated > 0) break;
            } catch {
                if (terminated > 0) break;
            }
        }
        expect(exited).toBe(1);
        expect(terminated).toBe(1);
        // No duplicates after a settle window.
        await new Promise((r) => setTimeout(r, 300));
        try {
            const extra = await Promise.race([
                client.waitForEvent('exited', 300),
                client.waitForEvent('terminated', 300),
            ]);
            throw new Error(`unexpected duplicate event: ${extra.event}`);
        } catch (err) {
            if ((err as Error).message.startsWith('unexpected duplicate')) throw err;
            // timeout — the expected outcome
        }
    } finally {
        client.close();
    }
}, 30_000);

test('e2e: a manual pause after stepping reports reason pause', async () => {
    // The stepPending flag is consumed by the step-completion pause and cleared
    // on every resume path; a stranded flag mislabels a later manual pause as
    // 'step'.
    const client = connectStdio();
    try {
        const httpPort = await getAvailablePort();
        const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
        expect(init.success, init.message).toBe(true);
        const launch = await client.send('launch', {
            program: serverFixture,
            cwd: import.meta.dir,
            stopOnEntry: false,
            noDebug: false,
            runtime: 'bun',
            env: { PORT: String(httpPort) },
        });
        expect(launch.success, launch.message).toBe(true);
        await client.waitForEvent('initialized');
        await armBreakpoint(client, serverFixture, 7);

        const probe = async (): Promise<'ok' | 'paused' | 'never'> => {
            for (let i = 0; i < 25; i++) {
                try {
                    const outcome = await Promise.race([
                        fetch(`http://127.0.0.1:${httpPort}/hit`).then((r) => (r.ok ? 'ok' : 'err')),
                        new Promise<'paused'>((res) =>
                            setTimeout(() => {
                                res('paused');
                            }, 400)
                        ),
                    ]);
                    if (outcome === 'ok' || outcome === 'paused') return outcome;
                } catch {
                    // not reachable yet — retry
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            return 'never';
        };
        // Reach the bp, step once, continue — every resume path has run.
        expect(await probe()).toBe('paused');
        const bpStop = await client.waitForEvent('stopped', 10_000);
        expect(castObject(bpStop.body).reason).toBe('breakpoint');
        await client.send('next', { threadId: 1 });
        const stepStop = await client.waitForEvent('stopped', 10_000);
        expect(castObject(stepStop.body).reason).toBe('step');
        await client.send('continue', { threadId: 1 });

        // Clear the bp so the manual pause below is not raced by a bp hit; a
        // completed probe proves the removal landed (the handler ran unpaused).
        await client.send('setBreakpoints', { source: { path: serverFixture }, breakpoints: [] });
        expect(await probe()).toBe('ok');

        await client.send('pause', { threadId: 1 });
        expect(await probe()).toBe('paused');
        const pauseStop = await client.waitForEvent('stopped', 10_000);
        expect(castObject(pauseStop.body).reason).toBe('pause');

        await client.send('continue', { threadId: 1 });
        await client.send('disconnect', {});
    } finally {
        client.close();
    }
}, 30_000);
