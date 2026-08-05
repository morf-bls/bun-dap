import { EventEmitter } from 'node:events';
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { DevRequest, ResultOf } from '../../src/inspector/jsc-types';
import { BunDebugAdapter, type AdapterHost } from '../../src/adapter/adapter';

/**
 * A controllable stand-in for `WebSocketInspector` for unit-style adapter
 * tests. Mirrors the surface the adapter touches: `send`, `on/off/emit`,
 * `close`, and the `isConnected` getter. Each `send` records the call and
 * resolves via a per-method handler (default: resolve `undefined`). Handlers
 * may return a value, a promise, throw, or — for race tests — delay via the
 * `delay` helper. This is the only way to exercise the adapter's async
 * internals (arm races, brake interleavings, swallowed throws)
 * deterministically without spawning real bun children.
 */
export class MockInspector extends EventEmitter {
  isConnected = true;
  /** Every send() call, in order. */
  readonly sent: Array<{ method: string; params: unknown }> = [];
  private readonly handlers = new Map<string, (params: unknown) => unknown>();

  /** Resolve a send with a fixed result value. */
  reply<M extends DevRequest>(method: M, result: ResultOf<M>): void {
    this.handlers.set(method, () => result);
  }

  /** Resolve a send via a function of its params (may return a promise). */
  handle(method: string, fn: (params: unknown) => unknown): void {
    this.handlers.set(method, fn);
  }

  send<M extends DevRequest>(method: M, params?: unknown): Promise<ResultOf<M>> {
    this.sent.push({ method, params });
    const fn = this.handlers.get(method);
    if (fn === undefined) return Promise.resolve(undefined as ResultOf<M>);
    try {
      return Promise.resolve(fn(params)) as Promise<ResultOf<M>>;
    } catch (err) {
      return Promise.reject(err) as Promise<ResultOf<M>>;
    }
  }

  close(): void {
    this.isConnected = false;
  }
}

/** Resolve after `ms` — used to simulate in-flight RPC latency. */
export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export interface HostLog {
  stopped: Array<{ reason: string; threadId: number; exceptionText?: string; hitBreakpointIds?: number[] }>;
  output: Array<{ category: string; text: string }>;
  breakpointChanged: DebugProtocol.Breakpoint[];
  initialized: number;
  threads: Array<{ reason: string; id: number }>;
  terminated: number;
  exited: number;
  processStarted: number;
}

export function recordingHost(): { host: AdapterHost; log: HostLog } {
  const log: HostLog = {
    stopped: [],
    output: [],
    breakpointChanged: [],
    initialized: 0,
    threads: [],
    terminated: 0,
    exited: 0,
    processStarted: 0,
  };
  const host: AdapterHost = {
    sendInitialized: () => { log.initialized++; },
    sendOutput: (category, text) => { log.output.push({ category, text }); },
    sendStopped: (reason, threadId, exceptionText, hitBreakpointIds) => {
      log.stopped.push({ reason, threadId, exceptionText, hitBreakpointIds });
    },
    sendBreakpointChanged: (bp) => { log.breakpointChanged.push(bp); },
    sendTerminated: () => { log.terminated++; },
    sendExited: () => { log.exited++; },
    sendThread: (reason, id) => { log.threads.push({ reason, id }); },
    sendProcessStarted: () => { log.processStarted++; },
  };
  return { host, log };
}

/**
 * Test-only seam: the adapter hides its inspector and `attachInspector` for
 * encapsulation; unit tests inject a mock and run the wiring through this
 * narrow named cast (never an inline member access).
 */
interface AdapterTestSeam {
  inspector: unknown;
  attachInspector(): Promise<void>;
  brakePending: boolean;
}

/**
 * Build an adapter backed by `mock`, with the inspector wired (events on) and
 * `initialized` already sent — the state a real launch reaches after
 * attachInspector. Returns the adapter plus the seam for tests that drive
 * private state directly (brakePending, pause frames, etc.).
 */
export async function mountAdapter(
  mock: MockInspector,
  host: AdapterHost,
): Promise<{ adapter: BunDebugAdapter; seam: AdapterTestSeam }> {
  const adapter = new BunDebugAdapter();
  adapter.host = host;
  const seam = adapter as unknown as AdapterTestSeam;
  seam.inspector = mock;
  await seam.attachInspector();
  return { adapter, seam };
}
