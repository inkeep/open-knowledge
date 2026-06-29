import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Scheduler } from '@inkeep/open-knowledge-core';
import { attachIdleShutdown } from './idle-shutdown';


interface ManualScheduler extends Scheduler {
  advanceTime(ms: number): void;
  pendingCount(): number;
}

function createManualScheduler(): ManualScheduler {
  type Entry = { id: number; cb: () => void; dueAt: number };
  const queue: Entry[] = [];
  let now = 0;
  let nextId = 1;

  return {
    setTimeout: (cb, ms) => {
      const id = nextId++;
      queue.push({ id, cb, dueAt: now + ms });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (handle) => {
      const id = handle as unknown as number;
      const idx = queue.findIndex((e) => e.id === id);
      if (idx >= 0) queue.splice(idx, 1);
    },
    now: () => now,
    advanceTime(ms) {
      now += ms;
      for (let pass = 0; pass < 100; pass++) {
        const due = queue.filter((e) => e.dueAt <= now);
        if (due.length === 0) return;
        for (const e of due) {
          const idx = queue.indexOf(e);
          if (idx >= 0) queue.splice(idx, 1);
          e.cb();
        }
      }
    },
    pendingCount: () => queue.length,
  };
}

function createFakeHttpServer(): HttpServer {
  return new EventEmitter() as unknown as HttpServer;
}

function createFakeSocket(): Duplex {
  return new EventEmitter() as unknown as Duplex;
}

function emitUpgrade(server: HttpServer, url: string, socket: Duplex): void {
  const req = { url } as unknown as IncomingMessage;
  (server as unknown as EventEmitter).emit('upgrade', req, socket);
}


describe('attachIdleShutdown', () => {
  test('fires onShutdown after thresholdMs when zero WebSocket clients', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
    });

    expect(onShutdown).toHaveBeenCalledTimes(0);
    scheduler.advanceTime(29_999);
    expect(onShutdown).toHaveBeenCalledTimes(0);
    scheduler.advanceTime(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  test('incrementing WebSocket client count clears the shutdown timer', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    scheduler.advanceTime(10_000);
    emitUpgrade(server, '/collab', createFakeSocket());

    scheduler.advanceTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(0);
  });

  test('decrementing WebSocket client count to zero restarts the timer', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    const socket = createFakeSocket();
    emitUpgrade(server, '/collab', socket);
    scheduler.advanceTime(60_000);
    expect(onShutdown).toHaveBeenCalledTimes(0);

    (socket as unknown as EventEmitter).emit('close');
    scheduler.advanceTime(29_999);
    expect(onShutdown).toHaveBeenCalledTimes(0);
    scheduler.advanceTime(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  test('reconnecting within the threshold resets the timer', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    scheduler.advanceTime(20_000);
    emitUpgrade(server, '/collab', createFakeSocket());
    scheduler.advanceTime(20_000); // would have fired; does not
    expect(onShutdown).toHaveBeenCalledTimes(0);
  });

  test('upgrades on non-/collab paths do NOT count', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    emitUpgrade(server, '/ws-other', createFakeSocket());
    emitUpgrade(server, '/api/config', createFakeSocket());
    scheduler.advanceTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  test('DirectConnections (no HTTP upgrade) do not affect the counter', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    scheduler.advanceTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  test('emits WARN at thresholdMs - warnBeforeMs (default 5 min before)', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const warnSpy = mock((_data: unknown, _message: string) => {});
    const log = {
      warn: warnSpy,
      info: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    } as unknown as Parameters<typeof attachIdleShutdown>[0]['log'];
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30 * 60 * 1000, // 30 min
      warnBeforeMs: 5 * 60 * 1000, // 5 min
      onShutdown,
      scheduler,
      log,
    });

    scheduler.advanceTime(25 * 60 * 1000 - 1);
    expect(warnSpy).toHaveBeenCalledTimes(0);
    scheduler.advanceTime(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(0);
    scheduler.advanceTime(5 * 60 * 1000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  test('WARN is suppressed if warnBeforeMs >= thresholdMs', () => {
    const scheduler = createManualScheduler();
    const warnSpy = mock((_data: unknown, _message: string) => {});
    const log = {
      warn: warnSpy,
      info: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    } as unknown as Parameters<typeof attachIdleShutdown>[0]['log'];
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 5_000,
      warnBeforeMs: 10_000, // greater than threshold
      onShutdown: () => Promise.resolve(),
      scheduler,
      log,
    });

    scheduler.advanceTime(5_000);
    expect(warnSpy).toHaveBeenCalledTimes(0);
  });

  test('detach() removes listener and cancels pending timers', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    const handle = attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
    });

    expect(scheduler.pendingCount()).toBeGreaterThan(0);
    handle.detach();
    expect(scheduler.pendingCount()).toBe(0);

    emitUpgrade(server, '/collab', createFakeSocket());
    scheduler.advanceTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(0);
  });

  test('detach() is idempotent and safe to call after onShutdown fires', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    const handle = attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    scheduler.advanceTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);

    expect(() => handle.detach()).not.toThrow();
    expect(() => handle.detach()).not.toThrow();
  });

  test('onShutdown fires exactly once even if timer would re-trigger', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 10_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    scheduler.advanceTime(10_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);

    const socket = createFakeSocket();
    emitUpgrade(server, '/collab', socket);
    (socket as unknown as EventEmitter).emit('close');
    scheduler.advanceTime(100_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  test('multiple concurrent WebSocket clients decrement independently', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => Promise.resolve());
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 30_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    const s1 = createFakeSocket();
    const s2 = createFakeSocket();
    emitUpgrade(server, '/collab', s1);
    emitUpgrade(server, '/collab', s2);

    (s1 as unknown as EventEmitter).emit('close');
    scheduler.advanceTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(0);

    (s2 as unknown as EventEmitter).emit('close');
    scheduler.advanceTime(30_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  test('synchronous onShutdown is supported', () => {
    const scheduler = createManualScheduler();
    const onShutdown = mock(() => {}); // void return, not a Promise
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 5_000,
      onShutdown,
      scheduler,
      warnBeforeMs: 0,
    });

    scheduler.advanceTime(5_000);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  test('async onShutdown rejection is caught (logged, not thrown)', () => {
    const scheduler = createManualScheduler();
    const errorSpy = mock((_data: unknown, _message: string) => {});
    const log = {
      warn: mock(() => {}),
      info: mock(() => {}),
      error: errorSpy,
      debug: mock(() => {}),
    } as unknown as Parameters<typeof attachIdleShutdown>[0]['log'];
    const server = createFakeHttpServer();

    attachIdleShutdown({
      httpServer: server,
      thresholdMs: 5_000,
      onShutdown: () => Promise.reject(new Error('boom')),
      scheduler,
      warnBeforeMs: 0,
      log,
    });

    expect(() => scheduler.advanceTime(5_000)).not.toThrow();
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(errorSpy).toHaveBeenCalledTimes(1);
        resolve();
      });
    });
  });
});
