import type { PausedEvent } from '../src/inspector/jsc-types';
import { must } from './util/dap-helpers';
import { MockInspector, delay, mountAdapter, recordingHost } from './util/mock-inspector';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { PassThrough } from 'node:stream';

// Unit-style adapter tests that drive the adapter's async internals against
// a MockInspector deterministically — the only way to reproduce in-flight
// arm races, brake interleavings, and multi-bp-per-pause gating without
// flaky real-bun timing.

const ABS_PATH = '/src/mod.ts';
const BP_LINE = 1;

/** Wire setBreakpointByUrl to hand out distinct ids in call order. */
function armCounter(mock: MockInspector, prefix: string): void {
    let n = 0;
    mock.handle('Debugger.setBreakpointByUrl', () => ({
        breakpointId: `${prefix}${++n}`,
        locations: [{ scriptId: 's1', lineNumber: BP_LINE - 1, columnNumber: 0 }],
    }));
}

/** Narrow a recorded mock send's unknown params to a plain object for reads. */
function paramsOf(s: { method: string; params: unknown }): Record<string, unknown> {
    return s.params !== null && typeof s.params === 'object' ? (s.params as Record<string, unknown>) : {};
}

function makePause(lineNumber: number, reason = 'PauseOnNextStatement', data?: Record<string, unknown>): PausedEvent {
    return {
        callFrames: [
            {
                callFrameId: 'cf1',
                functionName: '',
                location: { scriptId: 's1', lineNumber, columnNumber: 0 },
                scopeChain: [],
                this: { type: 'object' },
            },
        ],
        reason,
        data: data,
    };
}

test('every logpoint sharing a pause emits its message (not just the first)', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    armCounter(mock, 'bp');
    // evaluateOnCallFrame returns a bare result so evalLogpoint does not throw.
    mock.reply('Debugger.evaluateOnCallFrame', { result: { type: 'undefined' }, wasThrown: false });
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    // Two deferred logpoints on the SAME line (one source). Both land in
    // pendingByPath; the brake pause at that line puts both keys in brakeKeys,
    // so onPaused sees both in one pause.
    const set = await adapter.setBreakpoints({
        source: { path: ABS_PATH },
        breakpoints: [
            { line: BP_LINE, logMessage: 'A=1' },
            { line: BP_LINE, logMessage: 'B=2' },
        ],
    });
    expect(set.length).toBe(2);

    await adapter.configurationDone();
    // Script parses → deferred arms bind; NoopSourceMap (no sourceMapURL).
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    // Brake pause at the first statement (line BP_LINE). No breakpointId in
    // data → the placeholder branch is skipped, the brake branch supplies both.
    mock.emit('Debugger.paused', makePause(BP_LINE - 1));
    // Let the async onPaused (logpoint eval + resume) flush.
    await delay(50);

    const evals = mock.sent.filter((s) => s.method === 'Debugger.evaluateOnCallFrame');
    const consoleOutputs = log.output.filter((o) => o.category === 'console');
    // Pre-fix: only the first logpoint was evaluated/emitted.
    expect(evals.length, 'both logpoints should be evaluated').toBe(2);
    expect(consoleOutputs.length, 'both logpoints should emit console output').toBe(2);
    expect(log.stopped.length, 'logpoints never stop').toBe(0);
}, 10_000);

test('aliased placeholder consume re-arms the real bp so later passes hit', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    // setBreakpointByUrl: a line-0 call is the placeholder (id "ph1", no
    // resolved location yet); a bp arm at a real line gets a distinct id.
    let bpArmN = 0;
    mock.handle('Debugger.setBreakpointByUrl', (params) => {
        const ln = (params as { lineNumber: number }).lineNumber;
        if (ln === 0) return { breakpointId: 'ph1', locations: [] };
        bpArmN++;
        return { breakpointId: `real${bpArmN}`, locations: [{ scriptId: 's1', lineNumber: ln, columnNumber: 0 }] };
    });
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    const LINE = 3;
    // Deferred bp (script not parsed) → placeholder "ph1" armed, pending key registered.
    await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: LINE }] });
    // Script parses → deferred bp arms at LINE-1 (NoopSourceMap identity).
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    // Placeholder resolves to the bp's line → alias set (NoopSourceMap: line-only match).
    mock.emit('Debugger.breakpointResolved', {
        breakpointId: 'ph1',
        location: { scriptId: 's1', lineNumber: LINE - 1, columnNumber: 0 },
    });
    // No pending left (scriptParsed consumed it) → configurationDone arms no brake.
    await adapter.configurationDone();
    // The aliased placeholder's pause: data.breakpointId = "ph1".
    mock.emit('Debugger.paused', makePause(LINE - 1, 'Breakpoint', { breakpointId: 'ph1' }));
    await delay(50);

    // The alias-consume path must removeBreakpoint("ph1") AND re-arm the real
    // bp (a new setBreakpointByUrl at LINE-1) while still paused, so later
    // passes hit. Pre-fix: only the original arm — no re-arm — so JSC's dedup
    // (one location, two ids) left nothing armed after the placeholder removal.
    const bpArms = mock.sent.filter(
        (s) =>
            s.method === 'Debugger.setBreakpointByUrl' && (s.params as { lineNumber: number }).lineNumber === LINE - 1
    );
    expect(bpArms.length, 'real bp re-armed after alias consume').toBe(2);
    const removes = mock.sent.filter(
        (s) => s.method === 'Debugger.removeBreakpoint' && (s.params as { breakpointId: string }).breakpointId === 'ph1'
    );
    expect(removes.length, 'placeholder disarmed on alias consume').toBe(1);
    expect(log.stopped.length).toBe(1);
    expect(must(log.stopped[0]).reason).toBe('breakpoint');
}, 10_000);

test('in-flight arm orphaned by setBreakpoints replacement is removed', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    const removed: string[] = [];
    let armResolve: (() => void) | undefined;
    // Placeholder arms immediately; the real (deferred) arm stalls so we can
    // race a full-replacement setBreakpoints through while it is in flight.
    mock.handle('Debugger.setBreakpointByUrl', (params) => {
        if (params && typeof params === 'object' && 'lineNumber' in params) {
            const ln = (params as { lineNumber: number }).lineNumber;
            if (ln === 0) return { breakpointId: 'ph1', locations: [] };
            // Real arm: hold until the test releases it.
            const { promise, resolve } = Promise.withResolvers<{
                breakpointId: string;
                locations: { scriptId: string; lineNumber: number; columnNumber: number }[];
            }>();
            armResolve = () => {
                resolve({ breakpointId: 'real1', locations: [{ scriptId: 's1', lineNumber: ln, columnNumber: 0 }] });
            };
            return promise;
        }
        return { breakpointId: 'real1', locations: [] };
    });
    mock.reply('Debugger.resume', undefined);
    mock.handle('Debugger.removeBreakpoint', (params) => {
        if (params && typeof params === 'object' && 'breakpointId' in params)
            removed.push((params as { breakpointId: string }).breakpointId);
        return undefined;
    });
    const { adapter } = await mountAdapter(mock, host);

    const LINE = 3;
    // Deferred bp (script not parsed) → placeholder "ph1", pending registered.
    await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: LINE }] });
    // Script parses → onScriptParsed fires the real arm (stalled in flight).
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    await delay(10); // let the arm RPC enter its await

    // Full replacement: clears the bp while its arm RPC is still in flight.
    // bp.jscBreakpointId is still undefined, so the replacement removes nothing
    // from JSC — the about-to-resolve arm would orphan a JSC bp (real1) with no
    // DAP bp referencing it.
    await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [] });

    // Release the in-flight arm; the liveness re-check must dispose the orphan.
    must(armResolve)();
    await delay(20);

    expect(removed, 'orphaned arm bp removed after liveness re-check').toContain('real1');
}, 10_000);

test('placeholder pause via data.breakpoints is swallowed', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    mock.reply('Debugger.setBreakpointByUrl', { breakpointId: 'ph1', locations: [] });
    mock.reply('Debugger.removeBreakpoint', undefined);
    mock.reply('Debugger.resume', undefined);
    const { adapter, seam } = await mountAdapter(mock, host);

    // Deferred bp → placeholder "ph1" armed.
    await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: BP_LINE }] });
    await adapter.configurationDone();
    // Clear brakePending so the brake branch does not run — the swallow must
    // come from the placeholder path testing data.breakpoints, not the brake.
    seam.brakePending = false;
    // Placeholder pause: JSC reports the id under data.breakpoints (array),
    // NOT data.breakpointId. The placeholder is non-aliased (no
    // breakpointResolved at this line), so it must be swallowed, not surfaced.
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpoints: ['ph1'] }));
    await delay(50);

    expect(log.stopped.length, 'non-aliased placeholder pause swallowed').toBe(0);
    expect(seam.brakePending, 'brakePending untouched').toBe(false);
}, 10_000);

test('brake does not swallow an exception pause while brakePending', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    // A real bp at BP_LINE arms so a 'Breakpoint' pause would join gating,
    // but this test emits an 'exception' pause — the brake branch must NOT
    // treat it as the brake's (only PauseOnNextStatement/'other' qualify),
    // so it is processed normally and STOPPED, with brakePending kept true.
    armCounter(mock, 'bp');
    mock.reply('Debugger.resume', undefined);
    const { seam } = await mountAdapter(mock, host);
    // Mark brakePending manually (configurationDone's Debugger.pause is the
    // normal setter; here we simulate a brake armed then an exception fires
    // before the brake's own pause arrives).
    seam.brakePending = true;

    mock.emit(
        'Debugger.paused',
        makePause(BP_LINE - 1, 'exception', { exceptionData: { type: 'string', value: 'boom' } })
    );
    await delay(50);

    // Pre-fix: the brake branch swallowed any pause while brakePending,
    // including the exception, hiding it from the client.
    expect(log.stopped.length, 'exception pause not swallowed by brake').toBe(1);
    expect(must(log.stopped[0]).reason, 'exception surfaced as exception').toBe('exception');
    expect(seam.brakePending, 'brakePending preserved across non-brake pause').toBe(true);
}, 10_000);

test('bp hit with firstPausePending set reports breakpoint, not entry', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    // Arm a real bp at BP_LINE: setBreakpointByUrl returns a jsc id we map to
    // a DAP bp via jscToDapKey. A pause carrying that id is a real bp hit.
    mock.reply('Debugger.setBreakpointByUrl', {
        breakpointId: 'real1',
        locations: [{ scriptId: 's1', lineNumber: BP_LINE - 1, columnNumber: 0 }],
    });
    mock.reply('Debugger.resume', undefined);
    mock.reply('Debugger.removeBreakpoint', undefined);
    const { adapter, seam } = await mountAdapter(mock, host);

    // Real bp armed (script already parsed via mountAdapter? No — arm needs a
    // source entry. Emit scriptParsed so setBreakpoints arms immediately.)
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    const set = await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: BP_LINE }] });
    expect(must(set[0]).verified).toBe(true);

    // Simulate stopOnEntry: firstPausePending true and an entry bp armed.
    seam.firstPausePending = true;
    seam.entryBreakpointId = 'entry1';

    // Pause carries the REAL bp's jsc id (real1), NOT the entry bp id. This is
    // a genuine bp hit racing the entry stop — it must report 'breakpoint'.
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpointId: 'real1' }));
    await delay(50);

    expect(log.stopped.length, 'bp hit surfaces a stop').toBe(1);
    expect(must(log.stopped[0]).reason, 'bp hit reports breakpoint not entry').toBe('breakpoint');
    // Entry bp NOT disarmed: the stop was the bp's, the entry stop is still owed.
    expect(seam.entryBreakpointId, 'entry bp kept for owed entry stop').toBe('entry1');
    expect(seam.firstPausePending, 'firstPausePending still owed').toBe(true);
}, 10_000);

test('pure entry stop (no bp hit) reports entry and disarms entry bp', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    mock.reply('Debugger.removeBreakpoint', undefined);
    mock.reply('Debugger.resume', undefined);
    const { seam } = await mountAdapter(mock, host);

    seam.firstPausePending = true;
    seam.entryBreakpointId = 'entry1';

    // Brake pause (Debugger.pause) at the entry statement with NO bp hit — the
    // genuine entry stop. Must report 'entry' and disarm the entry bp.
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'PauseOnNextStatement'));
    await delay(50);

    expect(log.stopped.length, 'entry stop surfaces').toBe(1);
    expect(must(log.stopped[0]).reason, 'pure entry stop reports entry').toBe('entry');
    expect(seam.entryBreakpointId, 'entry bp disarmed after entry stop').toBeUndefined();
    expect(seam.firstPausePending, 'firstPausePending cleared').toBe(false);
}, 10_000);

test('aliased entry-bp placeholder reports bp stop, keeps entry bp for entry stop', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    const removed: string[] = [];
    // Placeholder arm (line 0) + real bp arm at LINE-1 (line 2).
    mock.handle('Debugger.setBreakpointByUrl', (params) => {
        if (params && typeof params === 'object' && 'lineNumber' in params) {
            const ln = (params as { lineNumber: number }).lineNumber;
            if (ln === 0) return { breakpointId: 'ph1', locations: [] };
            return { breakpointId: 'real1', locations: [{ scriptId: 's1', lineNumber: ln, columnNumber: 0 }] };
        }
        return { breakpointId: 'real1', locations: [] };
    });
    mock.reply('Debugger.resume', undefined);
    mock.handle('Debugger.removeBreakpoint', (params) => {
        if (params && typeof params === 'object' && 'breakpointId' in params)
            removed.push((params as { breakpointId: string }).breakpointId);
        return undefined;
    });
    const { adapter, seam } = await mountAdapter(mock, host);

    const LINE = 3;
    // Deferred bp → placeholder "ph1" armed, pending registered.
    await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: LINE }] });
    // Script parses → real bp arms at LINE-1 (line 2).
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    await delay(10);
    // Placeholder resolves to the bp's line (line 2) → alias set (NoopSourceMap: line-only).
    mock.emit('Debugger.breakpointResolved', {
        breakpointId: 'ph1',
        location: { scriptId: 's1', lineNumber: LINE - 1, columnNumber: 0 },
    });
    // stopOnEntry: the placeholder doubles as the entry bp.
    seam.entryBreakpointId = 'ph1';
    seam.entryBreakpointUrl = ABS_PATH;
    seam.firstPausePending = true;
    mock.emit('Debugger.paused', makePause(LINE - 1, 'Breakpoint', { breakpointId: 'ph1' }));
    await delay(50);

    // Stop #1: bp hit — reports 'breakpoint', NOT 'entry'.
    expect(log.stopped.length, 'first stop surfaces').toBe(1);
    expect(must(log.stopped[0]).reason, 'aliased entry-bp placeholder reports breakpoint').toBe('breakpoint');
    // The placeholder/entry bp is NOT removed (kept for the owed entry stop).
    expect(removed, 'entry-bp placeholder not removed on bp stop').not.toContain('ph1');
    expect(seam.entryBreakpointId, 'entry bp still armed for entry stop').toBe('ph1');
    expect(seam.firstPausePending, 'firstPausePending still owed').toBe(true);
    // The alias is consumed (one-shot).
    expect(seam.placeholderAlias.has('ph1'), 'alias consumed').toBe(false);
    // Resume (client continue) so the entry bp can re-fire.
    await adapter.resume();
    // Second pause: the entry bp re-fires (statement revisited). Now non-aliased
    // placeholder with entry owed → falls through → reports 'entry' → disarms.
    mock.emit('Debugger.paused', makePause(LINE - 1, 'Breakpoint', { breakpointId: 'ph1' }));
    await delay(50);
    expect(log.stopped.length, 'second stop surfaces').toBe(2);
    expect(must(log.stopped[1]).reason, 'genuine entry stop reports entry').toBe('entry');
    expect(removed, 'entry bp disarmed after entry stop').toContain('ph1');
    expect(seam.entryBreakpointId, 'entry bp cleared after entry stop').toBeUndefined();
    expect(seam.firstPausePending, 'firstPausePending cleared after entry stop').toBe(false);
}, 10_000);

test('failed launch kills orphaned debuggee and clears launchedChild', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    const { adapter, seam } = await mountAdapter(mock, host);

    // Launch with a nonexistent runtime: spawn succeeds (Bun spawn returns a
    // child even for a bad binary), the child exits immediately, urlPromise
    // rejects ("debuggee exited before inspector connected"). Pre-fix the child
    // was orphaned (launchedChild kept); the fix kills it and clears the ref.
    let threw = false;
    try {
        await adapter.launch({
            program: ABS_PATH,
            cwd: '/tmp',
            runtime: '/nonexistent/bun-runtime',
            noDebug: false,
        });
    } catch {
        threw = true;
    }
    expect(threw, 'launch with bad runtime throws').toBe(true);
    expect(seam.launchedChild, 'launchedChild cleared after failed launch').toBeNull();
}, 15_000);

test('onPaused throw is swallowed to diagnostic, not unhandled', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    const { seam } = await mountAdapter(mock, host);

    // Force onPaused to throw: a brake pause with no overlap keys and no
    // entry owed takes the resumeInternal() early-return path. Make
    // Debugger.resume reject so the awaited send throws inside onPaused.
    mock.handle('Debugger.resume', () => {
        throw new Error('boom');
    });
    seam.brakePending = true;
    seam.firstPausePending = false;

    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = (chunk: string | Buffer) => {
        captured.push(String(chunk));
        return true;
    };
    try {
        mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'PauseOnNextStatement'));
        await delay(50);
    } finally {
        process.stderr.write = origWrite;
    }

    // The rejection must surface as a diagnostic, not an unhandled rejection.
    expect(captured.some((s) => s.includes('onPaused: boom'))).toBe(true);
}, 10_000);

test('condition truthiness: nonzero bigint stops, 0n does not', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    armCounter(mock, 'bp');
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    // Parse the script FIRST so setBreakpoints arms directly (bp1) instead of
    // deferring through a line-0 placeholder (which would consume bp1).
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });

    // Nonzero bigint: JSC returns no serialized value, only description.
    mock.reply('Debugger.evaluateOnCallFrame', { result: { type: 'bigint', description: '42n' }, wasThrown: false });
    await adapter.setBreakpoints({
        source: { path: ABS_PATH },
        breakpoints: [{ line: BP_LINE, condition: 'n' }],
    });
    await adapter.configurationDone();
    // Hit the armed bp (bp1 from armCounter).
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpoints: ['bp1'] }));
    await delay(50);
    // Pre-fix: !!undefined === false → resume swallowed the stop.
    expect(log.stopped.length, 'nonzero bigint condition should stop').toBe(1);

    // Now 0n: falsy, must NOT stop.
    log.stopped.length = 0;
    mock.reply('Debugger.evaluateOnCallFrame', { result: { type: 'bigint', description: '0n' }, wasThrown: false });
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpoints: ['bp1'] }));
    await delay(50);
    expect(log.stopped.length, '0n condition should not stop').toBe(0);
}, 10_000);

test('condition truthiness: symbol always stops', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    armCounter(mock, 'bp');
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    // Symbols have no value field; they are always truthy.
    mock.reply('Debugger.evaluateOnCallFrame', {
        result: { type: 'symbol', description: 'Symbol()' },
        wasThrown: false,
    });
    await adapter.setBreakpoints({
        source: { path: ABS_PATH },
        breakpoints: [{ line: BP_LINE, condition: 'sym' }],
    });
    await adapter.configurationDone();
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpoints: ['bp1'] }));
    await delay(50);
    expect(log.stopped.length, 'symbol condition should stop').toBe(1);
}, 10_000);

test('terminateDebuggee accepts IPv6 loopback [::1]', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    const { adapter, seam } = await mountAdapter(mock, host);

    // Simulate attach mode with an IPv6 loopback target. Bun's URL.hostname
    // returns the bracketed form "[::1]", which the old loopback check
    // (only "::1") never matched, refusing termination.
    seam.mode = 'attach';
    seam.attachHost = '[::1]';
    // Runtime.evaluate resolves a fake pid; process.kill on 999999 throws
    // ESRCH (caught), so terminateDebuggee resolves without side effects.
    mock.reply('Runtime.evaluate', { result: { type: 'number', value: 999999 }, wasThrown: false });

    let threw = false;
    let msg = '';
    try {
        await adapter.terminateDebuggee();
    } catch (err) {
        threw = true;
        msg = (err as Error).message;
    }
    expect(threw, 'should not throw loopback refusal for [::1]').toBe(false);
    expect(msg, '').toBe('');
}, 10_000);

test('evaluate with stale/unknown frameId throws, not global scope', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    armCounter(mock, 'bp');
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: BP_LINE }] });
    await adapter.configurationDone();
    // A real bp hit pauses and populates frameIdToCallFrame with id 1.
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpoints: ['bp1'] }));
    await delay(50);

    // frameId 999 was never issued. Pre-fix the else branch silently
    // evaluated the expression in global scope; it must throw instead.
    let threw = false;
    let msg = '';
    try {
        await adapter.evaluate({ expression: 'x', frameId: 999 });
    } catch (err) {
        threw = true;
        msg = (err as Error).message;
    }
    expect(threw, 'stale frameId should throw').toBe(true);
    expect(msg.toLowerCase()).toContain('frame');
    // No Runtime.evaluate should have been sent for the stale frame.
    const runtimeEvals = mock.sent.filter((s) => s.method === 'Runtime.evaluate');
    expect(runtimeEvals.length, 'no global-scope Runtime.evaluate for stale frame').toBe(0);
}, 10_000);

test('next() clears pause state when JSC omits Debugger.resumed', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    armCounter(mock, 'bp');
    mock.reply('Debugger.stepNext', undefined);
    const { adapter, seam } = await mountAdapter(mock, host);

    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: BP_LINE }] });
    await adapter.configurationDone();
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpoints: ['bp1'] }));
    await delay(50);
    expect(seam.paused, 'paused after bp hit').toBe(true);
    expect(adapter.stackTrace({ threadId: 1, startFrame: 0 }).stackFrames.length, 'frames after bp hit').toBe(1);

    // Step next. JSC does NOT emit Debugger.resumed here (probe-verified), so
    // pre-fix the adapter stayed paused with stale frames.
    await adapter.next();
    await delay(20);
    expect(seam.paused, 'paused cleared after next()').toBe(false);
    expect(adapter.stackTrace({ threadId: 1, startFrame: 0 }).stackFrames.length, 'stackTrace empty after next()').toBe(
        0
    );
}, 10_000);

test('stderr scrape emits pre-URL bytes once and keeps same-chunk remainder', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    const { seam } = await mountAdapter(mock, host);

    const stderr = new PassThrough();
    // Pre-URL text split across two chunks, URL, then a same-chunk remainder.
    stderr.write(Buffer.from('pre-one '));
    stderr.write(Buffer.from('pre-two ws://127.0.0.1:9229/abc remainder'));
    stderr.end();

    const url = await seam.scrapeInspectorUrl(stderr);
    expect(url).toBe('ws://127.0.0.1:9229/abc');
    await delay(20);

    const out = log.output
        .filter((o) => o.category === 'stderr')
        .map((o) => o.text)
        .join('');
    // Pre-fix: the prefix re-emitted already-forwarded chunks ('pre-one ' and
    // 'pre-two ' re-emitted), and the post-URL remainder was dropped. The fix
    // forwards each byte once, preserving verbatim spacing.
    expect(out, 'pre-URL + same-chunk remainder, each byte once').toBe('pre-one pre-two  remainder');
}, 10_000);

test('stackTrace reports column >= 1 for source-mapped frames', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    armCounter(mock, 'bp');
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    // Build a real inline source map from the sample fixture, like
    // port.sourcemap.test.ts does, so originalLocation returns a real
    // mapped position (not a NoopSourceMap identity).
    const fixture = resolvePath(import.meta.dir, 'fixtures/sample.ts');
    const dir = mkdtempSync(join(tmpdir(), 'bun-dap-l2-'));
    const outfile = join(dir, 'sample.js');
    const proc = Bun.spawnSync(['bun', 'build', fixture, '--sourcemap=inline', '--outfile', outfile]);
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const js = readFileSync(outfile, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    const m = /\/\/[#@]\s*sourceMappingURL=(\S+)/.exec(js);
    const mapUrl = m?.[1] ?? '';
    expect(mapUrl, 'inline sourceMappingURL present').not.toBe('');

    mock.emit('Debugger.scriptParsed', {
        scriptId: 's1',
        url: fixture,
        startLine: 0,
        startColumn: 0,
        sourceMapURL: mapUrl,
    });
    await adapter.setBreakpoints({ source: { path: fixture }, breakpoints: [{ line: 1 }] });
    await adapter.configurationDone();
    // Pause at generated line 0 (the first statement).
    mock.emit('Debugger.paused', makePause(0, 'Breakpoint', { breakpoints: ['bp1'] }));
    await delay(50);

    const { stackFrames } = adapter.stackTrace({ threadId: 1, startFrame: 0 });
    expect(stackFrames.length, 'a frame is reported').toBe(1);
    // Pre-fix: source-mapped frames reported column 0 (DAP columns are 1-based;
    // 0 means "unknown" to many clients, who then misplace the cursor).
    expect(must(stackFrames[0]).column, 'source-mapped frame column >= 1').toBeGreaterThanOrEqual(1);
}, 15_000);
test('failing condition on one bp does not suppress a sibling stop on the same pause', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    armCounter(mock, 'bp');
    mock.reply('Debugger.evaluateOnCallFrame', { result: { type: 'boolean', value: false }, wasThrown: false });
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    // Two bps on the SAME statement: the first has a failing condition, the
    // second none. The brake pause carries both keys (brakeOverlapKeys), so one
    // pause gates both. Pre-fix the loop resumed on the first failing bp and
    // the unconditioned sibling never stopped.
    await adapter.setBreakpoints({
        source: { path: ABS_PATH },
        breakpoints: [{ line: BP_LINE, condition: 'false' }, { line: BP_LINE }],
    });
    await adapter.configurationDone();
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    mock.emit('Debugger.paused', makePause(BP_LINE - 1));
    await delay(50);

    expect(log.stopped.length, 'sibling bp must still stop').toBe(1);
    expect(must(log.stopped[0]).reason).toBe('breakpoint');
    const resumes = mock.sent.filter((s) => s.method === 'Debugger.resume');
    expect(resumes.length, 'no swallow resume').toBe(0);
}, 10_000);

test('failing hitCondition on one bp does not suppress a sibling stop on the same pause', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    armCounter(mock, 'bp');
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    // Same shape as above, but the failing gate is a hitCondition ('2' not yet
    // reached on the first pause) instead of a condition.
    await adapter.setBreakpoints({
        source: { path: ABS_PATH },
        breakpoints: [{ line: BP_LINE, hitCondition: '2' }, { line: BP_LINE }],
    });
    await adapter.configurationDone();
    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    mock.emit('Debugger.paused', makePause(BP_LINE - 1));
    await delay(50);

    expect(log.stopped.length, 'sibling bp must still stop').toBe(1);
    expect(must(log.stopped[0]).reason).toBe('breakpoint');
    const resumes = mock.sent.filter((s) => s.method === 'Debugger.resume');
    expect(resumes.length, 'no swallow resume').toBe(0);
}, 10_000);

test('re-sent function bp with changed condition re-arms instead of being ignored', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    let symN = 0;
    mock.handle('Debugger.addSymbolicBreakpoint', () => ({ breakpointId: `sym${++symN}` }));
    const { adapter } = await mountAdapter(mock, host);

    const first = await adapter.setFunctionBreakpoints({ breakpoints: [{ name: 'foo' }] });
    expect(first.length).toBe(1);
    // Re-send the same symbol with a changed condition AND a hitCondition.
    // Pre-fix this was silently kept with the OLD gating (and the response came
    // back with zero breakpoints).
    const second = await adapter.setFunctionBreakpoints({
        breakpoints: [{ name: 'foo', condition: 'x > 1', hitCondition: '3' }],
    });
    expect(second.length, 'changed bp is re-armed, not silently kept').toBe(1);

    const adds = mock.sent.filter((s) => s.method === 'Debugger.addSymbolicBreakpoint');
    expect(adds.length, 'two arms: original + re-arm').toBe(2);
    expect(paramsOf(must(adds[1])).condition, 'new condition reaches JSC').toBe('x > 1');
    const removes = mock.sent.filter((s) => s.method === 'Debugger.removeSymbolicBreakpoint');
    expect(removes.length, 'old symbolic bp removed before re-arm').toBe(1);
    expect(paramsOf(must(removes[0])).symbol).toBe('foo');
}, 10_000);

test('process event only in launch mode (attach would report pid 0)', async () => {
    const mock = new MockInspector();
    const { host, log } = recordingHost();
    const { adapter, seam } = await mountAdapter(mock, host);
    seam.mode = 'launch';
    seam.launchedChild = { pid: 4242 };
    await adapter.configurationDone();
    expect(log.processStarted, 'launch with a child reports the real pid').toBe(1);
    expect(log.threads.length, 'thread started still reported').toBe(1);
    // `process` event would carry a fabricated pid 0.
    const mock2 = new MockInspector();
    const { host: host2, log: log2 } = recordingHost();
    const { adapter: adapter2, seam: seam2 } = await mountAdapter(mock2, host2);
    seam2.mode = 'attach';
    await adapter2.configurationDone();
    expect(log2.processStarted, 'attach emits no process event').toBe(0);
    expect(log2.threads.length, 'attach still reports the thread').toBe(1);
}, 10_000);

test('resume releases evaluate object groups so the debuggee drops retained objects', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    mock.reply('Debugger.resume', undefined);
    mock.reply('Debugger.stepNext', undefined);
    const { adapter } = await mountAdapter(mock, host);

    await adapter.resume();
    const releases = mock.sent.filter((s) => s.method === 'Runtime.releaseObjectGroup');
    expect(releases.length, 'resume releases all evaluate groups').toBe(3);
    const resumeIdx = mock.sent.findIndex((s) => s.method === 'Debugger.resume');
    expect(releases.map((r) => String(paramsOf(r).objectGroupName)).sort()).toEqual(['console', 'debugger', 'repl']);
    const lastReleaseIdx = Math.max(...releases.map((r) => mock.sent.indexOf(r)));
    expect(resumeIdx, 'Debugger.resume sent').toBeGreaterThanOrEqual(0);
    expect(lastReleaseIdx, 'groups released BEFORE the resume RPC').toBeLessThan(resumeIdx);
    await adapter.stepIn();
    const total = mock.sent.filter((s) => s.method === 'Runtime.releaseObjectGroup');
    expect(total.length, 'step paths release the groups too').toBe(6);
}, 10_000);

test('variables honors start/count paging', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    armCounter(mock, 'bp');
    mock.reply('Debugger.resume', undefined);
    const { adapter } = await mountAdapter(mock, host);

    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: BP_LINE }] });
    await adapter.configurationDone();
    // Pause with a real local scope so scopes() hands out an object ref.
    const pause = makePause(BP_LINE - 1, 'Breakpoint', { breakpoints: ['bp1'] });
    must(pause.callFrames[0]).scopeChain = [{ type: 'closure', object: { type: 'object', objectId: 'scope1' } }];
    mock.emit('Debugger.paused', pause);
    await delay(50);

    const local = (await adapter.scopes(1)).find((s) => s.name === 'Local');
    expect(local, 'local scope present').toBeDefined();
    const ref = must(local).variablesReference;
    expect(ref, 'scope ref is a real object ref').toBeGreaterThan(0);

    const props = Array.from({ length: 10 }, (_, i) => ({
        name: `p${i}`,
        value: { type: 'number', value: i },
    }));
    mock.reply('Runtime.getDisplayableProperties', { properties: props });

    // Pre-fix: the whole list was dumped regardless of start/count.
    const page = await adapter.variables({ variablesReference: ref, start: 2, count: 3 });
    expect(
        page.map((v) => v.name),
        'start/count slice'
    ).toEqual(['p2', 'p3', 'p4']);
}, 10_000);

// Pins the `isAbsolute` + empty-string internal-frame classification
// (replaces the old `!startsWith('/')` check that mis-flagged Windows absolute
// paths). On posix these guard the branch we actually run under; the fix is
// cross-OS but the observable contract is platform-dependent.
test('absolute-posix-path frame is NOT internal', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    const { adapter } = await mountAdapter(mock, host);

    mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
    const pause = makePause(0, 'Breakpoint', { breakpoints: ['bp1'] });
    mock.emit('Debugger.paused', pause);
    await delay(20);

    const { stackFrames } = adapter.stackTrace({ threadId: 1, startFrame: 0 });
    expect(stackFrames.length, 'a frame is reported').toBe(1);
    // isAbsolute('/src/mod.ts') === true → not internal: real source, no subtle hint.
    expect(must(stackFrames[0]).presentationHint, 'absolute path not subtle').toBeUndefined();
    expect(must(stackFrames[0]).source?.path, 'source path preserved').toBe(ABS_PATH);
    expect(must(stackFrames[0]).name, 'not <internal>').not.toBe('<internal>');
}, 10_000);

test('empty/non-absolute path frame IS internal', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    const { adapter } = await mountAdapter(mock, host);

    // No sourceMapURL → NoopSourceMap; an empty url yields sourcePath '' which
    // is the explicit internal branch (sourcePath === '').
    mock.emit('Debugger.scriptParsed', { scriptId: 's2', url: '', startLine: 0, startColumn: 0 });
    const pause = makePause(0, 'Breakpoint', { breakpoints: ['bp1'] });
    // Re-target the frame's location to the empty-url script.
    must(pause.callFrames[0]).location = { scriptId: 's2', lineNumber: 0, columnNumber: 0 };
    mock.emit('Debugger.paused', pause);
    await delay(20);

    const { stackFrames } = adapter.stackTrace({ threadId: 1, startFrame: 0 });
    expect(stackFrames.length, 'a frame is reported').toBe(1);
    // empty path → internal: subtle hint, <internal> name, no source object.
    expect(must(stackFrames[0]).presentationHint, 'empty path is subtle').toBe('subtle');
    expect(must(stackFrames[0]).name, 'internal name').toBe('<internal>');
    expect(must(stackFrames[0]).source, 'no source for internal').toBeUndefined();
}, 10_000);

// scopes()/variables()/evaluate() must advertise indexedVariables when a
// container exceeds the paging threshold (100), so a compliant DAP client
// knows to send start/count. Without advertised counts the start/count
// slicing is dead code — the client has no signal that the collection is large.
test('scope with >threshold properties advertises indexedVariables', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    const { adapter } = await mountAdapter(mock, host);

    const pause = makePause(0, 'Breakpoint', { breakpoints: ['bp1'] });
    must(pause.callFrames[0]).scopeChain = [{ type: 'local', object: { type: 'object', objectId: 'obj1' } }];
    mock.emit('Debugger.paused', pause);
    await delay(20);

    // 150 properties → above the 100 threshold → indexedVariables advertised.
    const big = Array.from({ length: 150 }, (_, i) => ({
        name: String(i),
        value: { type: 'number', value: i },
    }));
    mock.reply('Runtime.getDisplayableProperties', { properties: big });

    const scopes = await adapter.scopes(1);
    const local = scopes.find((s) => s.name === 'Local');
    expect(local, 'local scope present').toBeDefined();
    expect(must(local).variablesReference, 'scope ref is a real object ref').toBeGreaterThan(0);
    // 150 > 100 threshold → the count is advertised so clients page.
    expect(must(local).indexedVariables, 'advertised count for large scope').toBe(150);

    // A start/count request now returns the requested window of the big list.
    const page = await adapter.variables({ variablesReference: must(local).variablesReference, start: 10, count: 5 });
    expect(page.length, 'paged window length').toBe(5);
    expect(
        page.map((v) => v.name),
        'paged window names'
    ).toEqual(['10', '11', '12', '13', '14']);
}, 10_000);

test('scope with <=threshold properties does NOT advertise counts', async () => {
    const mock = new MockInspector();
    const { host } = recordingHost();
    const { adapter } = await mountAdapter(mock, host);

    const pause = makePause(0, 'Breakpoint', { breakpoints: ['bp1'] });
    must(pause.callFrames[0]).scopeChain = [{ type: 'local', object: { type: 'object', objectId: 'obj2' } }];
    mock.emit('Debugger.paused', pause);
    await delay(20);

    // 10 properties → below threshold → keep the response clean (no count field).
    const small = Array.from({ length: 10 }, (_, i) => ({
        name: `p${i}`,
        value: { type: 'number', value: i },
    }));
    mock.reply('Runtime.getDisplayableProperties', { properties: small });

    const scopes = await adapter.scopes(1);
    const local = scopes.find((s) => s.name === 'Local');
    expect(local, 'local scope present').toBeDefined();
    expect(must(local).variablesReference, 'scope ref is a real object ref').toBeGreaterThan(0);
    expect(must(local).indexedVariables, 'no count advertised below threshold').toBeUndefined();
}, 10_000);
