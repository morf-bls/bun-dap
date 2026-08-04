import { spawn } from 'bun';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

/** Minimal Content-Length-framed DAP client for transport-level tests. */

export interface DapResponse {
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEvent {
  seq: number;
  type: 'event';
  event: string;
  body?: unknown;
}

const repoRoot = resolve(import.meta.dir, '..', '..');

type ResponseResolver = (resp: DapResponse) => void;

export class FramedClient {
  private seq = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, ResponseResolver>();
  private eventQueue: DapEvent[] = [];
  private eventWaiters = new Map<string, Array<{ resolve: (e: DapEvent) => void; timer: ReturnType<typeof setTimeout> }>>();

  constructor(
    private readonly writeFrame: (frame: string) => void,
    private readonly closeFn: () => void = () => {},
  ) {}

  feed(chunk: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('utf8'));
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      if (!Number.isFinite(len)) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const offset = headerEnd + 4;
      if (this.buffer.length < offset + len) return;
      const bodyText = this.buffer.subarray(offset, offset + len).toString('utf8');
      this.buffer = this.buffer.subarray(offset + len);
      let msg: unknown;
      try {
        msg = JSON.parse(bodyText);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const record = msg as Record<string, unknown>;
    if (record.type === 'event' && typeof record.event === 'string' && typeof record.seq === 'number') {
      const ev: DapEvent = { seq: record.seq, type: 'event', event: record.event, body: record.body };
      const waiters = this.eventWaiters.get(ev.event);
      if (waiters && waiters.length > 0) {
        this.eventWaiters.delete(ev.event);
        for (const w of waiters) {
          clearTimeout(w.timer);
          w.resolve(ev);
        }
      } else {
        this.eventQueue.push(ev);
      }
      return;
    }
    if (record.type === 'response' && typeof record.request_seq === 'number') {
      const resolve = this.pending.get(record.request_seq);
      if (resolve) {
        this.pending.delete(record.request_seq);
        resolve({
          request_seq: record.request_seq,
          success: record.success === true,
          command: typeof record.command === 'string' ? record.command : '',
          message: typeof record.message === 'string' ? record.message : undefined,
          body: record.body,
        });
      }
    }
  }

  send(command: string, args?: Record<string, unknown>): Promise<DapResponse> {
    const seq = ++this.seq;
    const { promise, resolve, reject } = Promise.withResolvers<DapResponse>();
    const bodyText = JSON.stringify({ type: 'request', seq, command, arguments: args });
    this.writeFrame(`Content-Length: ${Buffer.byteLength(bodyText)}\r\n\r\n${bodyText}`);
    const timer = setTimeout(() => {
      this.pending.delete(seq);
      reject(new Error(`no response to ${command} within 10s`));
    }, 10_000);
    timer.unref?.();
    this.pending.set(seq, (resp) => {
      clearTimeout(timer);
      resolve(resp);
    });
    return promise;
  }

  waitForEvent(eventType: string, timeoutMs = 10_000): Promise<DapEvent> {
    const queued = this.eventQueue.findIndex((e) => e.event === eventType);
    if (queued >= 0) return Promise.resolve(this.eventQueue.splice(queued, 1)[0]!);
    const { promise, resolve, reject } = Promise.withResolvers<DapEvent>();
    const timer = setTimeout(() => {
      this.eventWaiters.delete(eventType);
      reject(new Error(`no ${eventType} event within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const waiters = this.eventWaiters.get(eventType) ?? [];
    waiters.push({ resolve, timer });
    this.eventWaiters.set(eventType, waiters);
    return promise;
  }

  close(): void {
    this.closeFn();
  }
}

/** Spawn `bun run src/cli.ts` (stdio mode) and frame against it. */
export function connectStdio(): FramedClient {
  const proc = spawn(['bun', 'run', 'src/cli.ts'], {
    cwd: repoRoot,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const client = new FramedClient(
    (frame) => {
      proc.stdin.write(frame);
    },
    () => void proc.kill(),
  );
  void (async () => {
    try {
      for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) client.feed(Buffer.from(chunk));
    } catch (err) {
      console.error('[framed-client] stdout read error:', err);
    }
  })();
  return client;
}

/** Connect to a TCP-mode cli server. */
export function connectTcp(port: number, host = '127.0.0.1'): Promise<FramedClient> {
  const { promise, resolve, reject } = Promise.withResolvers<FramedClient>();
  const socket = createConnection({ host, port });
  const client = new FramedClient(
    (frame) => socket.write(frame),
    () => socket.destroy(),
  );
  socket.on('data', (chunk: Buffer) => client.feed(chunk));
  socket.once('connect', () => resolve(client));
  socket.once('error', reject);
  return promise;
}
