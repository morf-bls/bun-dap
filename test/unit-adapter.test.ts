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
