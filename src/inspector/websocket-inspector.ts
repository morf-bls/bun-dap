import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { DevRequest, DevRequestMap, ResultOf } from './jsc-types';

const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface RawReply {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string; data?: unknown };
}

/**
 * A small typed WebSocket client for Bun's WebKit (JSC) inspector.
 * Requests are correlated by id; responses resolve the matching promise.
 * Events (messages without an id) are re-emitted by method name and as
 * `'inspectorEvent'` with `{ method, params }`.
 */
export class WebSocketInspector extends EventEmitter {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, PendingRequest>();
  private buffered: string[] = [];
  /** Set once the socket has opened (marker for queuing). */
  private opened = false;

  constructor(url: string) {
    super();
    this.ws = new WebSocket(url, {
      headers: {
        'Ref-Event-Loop': '0',
      },
    });
    this.ws.on('open', () => {
      this.opened = true;
      const queued = this.buffered;
      this.buffered = [];
      for (const frame of queued) this.ws.send(frame);
      this.emit('connected');
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.onMessage(JSON.parse(data.toString()) as RawReply);
      } catch (err) {
        this.emit('error', err);
      }
    });
    this.ws.on('close', () => {
      const err = new Error('closed');
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
      this.emit('disconnected');
    });
    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /** True once the WebSocket is fully open. */
  get isConnected(): boolean {
    return this.opened;
  }

  /** Send one inspector request; resolves with the typed result. Rejects on JSC error or 10 s timeout. */
  send<M extends DevRequest>(method: M, params?: DevRequestMap[M]['params']): Promise<ResultOf<M>> {
    const msgId = ++this.id;
    const payload = JSON.stringify({ id: msgId, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`Inspector request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(msgId, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(payload);
      } else {
        this.buffered.push(payload);
        // If the socket never opens, nothing will flush; close() rejects pending.
      }
    });
  }

  /** Close the socket, rejecting every outstanding request with Error('closed'). */
  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closing
    }
    const err = new Error('closed');
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private onMessage(msg: RawReply): void {
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        const detail = Array.isArray(msg.error.data) && msg.error.data.length > 0
          ? `: ${msg.error.data.map((d) => JSON.stringify(d)).join(', ')}`
          : '';
        pending.reject(new Error(`${msg.error.message}${detail}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      this.emit(msg.method, msg.params);
      this.emit('inspectorEvent', { method: msg.method, params: msg.params });
    }
  }
}
