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
