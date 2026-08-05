import { test, expect } from 'bun:test';
import type { PausedEvent } from '../src/inspector/jsc-types';
import { MockInspector, recordingHost, mountAdapter, delay } from './util/mock-inspector';

// Unit-style adapter tests for the 2026-08 review pass. These drive the
// adapter's async internals against a MockInspector deterministically — the
// only way to reproduce in-flight arm races, brake interleavings, and
// multi-bp-per-pause gating without flaky real-bun timing.

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

function makePause(lineNumber: number, reason = 'PauseOnNextStatement', data?: Record<string, unknown>): PausedEvent {
  return {
    callFrames: [{
      callFrameId: 'cf1',
      functionName: '',
      location: { scriptId: 's1', lineNumber, columnNumber: 0 },
      scopeChain: [],
      this: { type: 'object' },
    }],
    reason,
    data: data as PausedEvent['data'],
  };
}

test('L24: every logpoint sharing a pause emits its message (not just the first)', async () => {
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

test('H1: aliased placeholder consume re-arms the real bp so later passes hit', async () => {
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
    (s) => s.method === 'Debugger.setBreakpointByUrl' && (s.params as { lineNumber: number }).lineNumber === LINE - 1,
  );
  expect(bpArms.length, 'real bp re-armed after alias consume').toBe(2);
  const removes = mock.sent.filter(
    (s) => s.method === 'Debugger.removeBreakpoint' && (s.params as { breakpointId: string }).breakpointId === 'ph1',
  );
  expect(removes.length, 'placeholder disarmed on alias consume').toBe(1);
  expect(log.stopped.length).toBe(1);
  expect(log.stopped[0]!.reason).toBe('breakpoint');
}, 10_000);

test('M2: in-flight arm orphaned by setBreakpoints replacement is removed', async () => {
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
      const { promise, resolve } = Promise.withResolvers<{ breakpointId: string; locations: Array<{ scriptId: string; lineNumber: number; columnNumber: number }> }>();
      armResolve = () => resolve({ breakpointId: 'real1', locations: [{ scriptId: 's1', lineNumber: ln, columnNumber: 0 }] });
      return promise;
    }
    return { breakpointId: 'real1', locations: [] };
  });
  mock.reply('Debugger.resume', undefined);
  mock.handle('Debugger.removeBreakpoint', (params) => { if (params && typeof params === 'object' && 'breakpointId' in params) removed.push((params as { breakpointId: string }).breakpointId); return undefined; });
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
  armResolve!();
  await delay(20);

  expect(removed, 'orphaned arm bp removed after liveness re-check').toContain('real1');
}, 10_000);

test('M9: placeholder pause via data.breakpoints is swallowed', async () => {
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

test('M1: brake does not swallow an exception pause while brakePending', async () => {
  const mock = new MockInspector();
  const { host, log } = recordingHost();
  // A real bp at BP_LINE arms so a 'Breakpoint' pause would join gating,
  // but this test emits an 'exception' pause — the brake branch must NOT
  // treat it as the brake's (only PauseOnNextStatement/'other' qualify),
  // so it is processed normally and STOPPED, with brakePending kept true.
  armCounter(mock, 'bp');
  mock.reply('Debugger.resume', undefined);
  const { adapter, seam } = await mountAdapter(mock, host);
  // Mark brakePending manually (configurationDone's Debugger.pause is the
  // normal setter; here we simulate a brake armed then an exception fires
  // before the brake's own pause arrives).
  seam.brakePending = true;

  mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'exception', { exceptionData: { type: 'string', value: 'boom' } }));
  await delay(50);

  // Pre-fix: the brake branch swallowed any pause while brakePending,
  // including the exception, hiding it from the client.
  expect(log.stopped.length, 'exception pause not swallowed by brake').toBe(1);
  expect(log.stopped[0]!.reason, 'exception surfaced as exception').toBe('exception');
  expect(seam.brakePending, 'brakePending preserved across non-brake pause').toBe(true);
}, 10_000);

test('M3: bp hit with firstPausePending set reports breakpoint, not entry', async () => {
  const mock = new MockInspector();
  const { host, log } = recordingHost();
  // Arm a real bp at BP_LINE: setBreakpointByUrl returns a jsc id we map to
  // a DAP bp via jscToDapKey. A pause carrying that id is a real bp hit.
  mock.reply('Debugger.setBreakpointByUrl', { breakpointId: 'real1', locations: [{ scriptId: 's1', lineNumber: BP_LINE - 1, columnNumber: 0 }] });
  mock.reply('Debugger.resume', undefined);
  mock.reply('Debugger.removeBreakpoint', undefined);
  const { adapter, seam } = await mountAdapter(mock, host);

  // Real bp armed (script already parsed via mountAdapter? No — arm needs a
  // source entry. Emit scriptParsed so setBreakpoints arms immediately.)
  mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
  const set = await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: BP_LINE }] });
  expect(set[0]!.verified).toBe(true);

  // Simulate stopOnEntry: firstPausePending true and an entry bp armed.
  seam.firstPausePending = true;
  seam.entryBreakpointId = 'entry1';

  // Pause carries the REAL bp's jsc id (real1), NOT the entry bp id. This is
  // a genuine bp hit racing the entry stop — it must report 'breakpoint'.
  mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpointId: 'real1' }));
  await delay(50);

  expect(log.stopped.length, 'bp hit surfaces a stop').toBe(1);
  expect(log.stopped[0]!.reason, 'bp hit reports breakpoint not entry').toBe('breakpoint');
  // Entry bp NOT disarmed: the stop was the bp's, the entry stop is still owed.
  expect(seam.entryBreakpointId, 'entry bp kept for owed entry stop').toBe('entry1');
  expect(seam.firstPausePending, 'firstPausePending still owed').toBe(true);
}, 10_000);

test('M3: pure entry stop (no bp hit) reports entry and disarms entry bp', async () => {
  const mock = new MockInspector();
  const { host, log } = recordingHost();
  mock.reply('Debugger.removeBreakpoint', undefined);
  mock.reply('Debugger.resume', undefined);
  const { adapter, seam } = await mountAdapter(mock, host);

  seam.firstPausePending = true;
  seam.entryBreakpointId = 'entry1';

  // Brake pause (Debugger.pause) at the entry statement with NO bp hit — the
  // genuine entry stop. Must report 'entry' and disarm the entry bp.
  mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'PauseOnNextStatement'));
  await delay(50);

  expect(log.stopped.length, 'entry stop surfaces').toBe(1);
  expect(log.stopped[0]!.reason, 'pure entry stop reports entry').toBe('entry');
  expect(seam.entryBreakpointId, 'entry bp disarmed after entry stop').toBeUndefined();
  expect(seam.firstPausePending, 'firstPausePending cleared').toBe(false);
}, 10_000);

test('M3: aliased entry-bp placeholder reports bp stop, keeps entry bp for entry stop', async () => {
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
  mock.handle('Debugger.removeBreakpoint', (params) => { if (params && typeof params === 'object' && 'breakpointId' in params) removed.push((params as { breakpointId: string }).breakpointId); return undefined; });
  const { adapter, seam } = await mountAdapter(mock, host);

  const LINE = 3;
  // Deferred bp → placeholder "ph1" armed, pending registered.
  await adapter.setBreakpoints({ source: { path: ABS_PATH }, breakpoints: [{ line: LINE }] });
  // Script parses → real bp arms at LINE-1 (line 2).
  mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
  await delay(10);
  // Placeholder resolves to the bp's line (line 2) → alias set (NoopSourceMap: line-only).
  mock.emit('Debugger.breakpointResolved', { breakpointId: 'ph1', location: { scriptId: 's1', lineNumber: LINE - 1, columnNumber: 0 } });
  // stopOnEntry: the placeholder doubles as the entry bp.
  seam.entryBreakpointId = 'ph1';
  seam.entryBreakpointUrl = ABS_PATH;
  seam.firstPausePending = true;
  mock.emit('Debugger.paused', makePause(LINE - 1, 'Breakpoint', { breakpointId: 'ph1' }));
  await delay(50);

  // Stop #1: bp hit — reports 'breakpoint', NOT 'entry'.
  expect(log.stopped.length, 'first stop surfaces').toBe(1);
  expect(log.stopped[0]!.reason, 'aliased entry-bp placeholder reports breakpoint').toBe('breakpoint');
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
  expect(log.stopped[1]!.reason, 'genuine entry stop reports entry').toBe('entry');
  expect(removed, 'entry bp disarmed after entry stop').toContain('ph1');
  expect(seam.entryBreakpointId, 'entry bp cleared after entry stop').toBeUndefined();
  expect(seam.firstPausePending, 'firstPausePending cleared after entry stop').toBe(false);
}, 10_000);

test('M7: failed launch kills orphaned debuggee and clears launchedChild', async () => {
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


test('L5: onPaused throw is swallowed to diagnostic, not unhandled', async () => {
  const mock = new MockInspector();
  const { host } = recordingHost();
  const { seam } = await mountAdapter(mock, host);

  // Force onPaused to throw: a brake pause with no overlap keys and no
  // entry owed takes the resumeInternal() early-return path. Make
  // Debugger.resume reject so the awaited send throws inside onPaused.
  mock.handle('Debugger.resume', () => { throw new Error('boom'); });
  seam.brakePending = true;
  seam.firstPausePending = false;

  const origWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: string | Buffer) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'PauseOnNextStatement'));
    await delay(50);
  } finally {
    process.stderr.write = origWrite;
  }

  // The rejection must surface as a diagnostic, not an unhandled rejection.
  expect(captured.some((s) => s.includes('onPaused: boom'))).toBe(true);
}, 10_000);

test('L9: condition truthiness: nonzero bigint stops, 0n does not', async () => {
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

test('L9: condition truthiness: symbol always stops', async () => {
  const mock = new MockInspector();
  const { host, log } = recordingHost();
  armCounter(mock, 'bp');
  mock.reply('Debugger.resume', undefined);
  const { adapter } = await mountAdapter(mock, host);

  mock.emit('Debugger.scriptParsed', { scriptId: 's1', url: ABS_PATH, startLine: 0, startColumn: 0 });
  // Symbols have no value field; they are always truthy.
  mock.reply('Debugger.evaluateOnCallFrame', { result: { type: 'symbol', description: 'Symbol()' }, wasThrown: false });
  await adapter.setBreakpoints({
    source: { path: ABS_PATH },
    breakpoints: [{ line: BP_LINE, condition: 'sym' }],
  });
  await adapter.configurationDone();
  mock.emit('Debugger.paused', makePause(BP_LINE - 1, 'Breakpoint', { breakpoints: ['bp1'] }));
  await delay(50);
  expect(log.stopped.length, 'symbol condition should stop').toBe(1);
}, 10_000);

test('L16: terminateDebuggee accepts IPv6 loopback [::1]', async () => {
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

test('L17: evaluate with stale/unknown frameId throws, not global scope', async () => {
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

test('L18: next() clears pause state when JSC omits Debugger.resumed', async () => {
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
  expect((await adapter.stackTrace({ threadId: 1, startFrame: 0 })).stackFrames.length, 'frames after bp hit').toBe(1);

  // Step next. JSC does NOT emit Debugger.resumed here (probe-verified), so
  // pre-fix the adapter stayed paused with stale frames.
  await adapter.next();
  await delay(20);
  expect(seam.paused, 'paused cleared after next()').toBe(false);
  expect((await adapter.stackTrace({ threadId: 1, startFrame: 0 })).stackFrames.length, 'stackTrace empty after next()').toBe(0);
}, 10_000);