/**
 * Buffered async-iterable stream — the queue mechanics shared by both HTTP
 * transports. Tests cover producer-before-consumer (buffer), consumer-before-
 * producer (waiter), terminal-event-aborts-signal, external-cancel-aborts-
 * signal, and idempotent cancel.
 */
import { describe, expect, test } from 'bun:test';
import { createBufferedAsyncStream } from './buffered-async-stream';

type TestEvent =
  | { type: 'progress'; n: number }
  | { type: 'complete'; result: string }
  | { type: 'error'; message: string };

async function collectAll<E>(events: AsyncIterable<E>): Promise<E[]> {
  const out: E[] = [];
  const iter = events[Symbol.asyncIterator]();
  let result = await iter.next();
  while (!result.done) {
    out.push(result.value);
    result = await iter.next();
  }
  return out;
}

describe('createBufferedAsyncStream', () => {
  test('producer pushes BEFORE consumer iterates — events are buffered', async () => {
    const stream = createBufferedAsyncStream<TestEvent>((push) => {
      push({ type: 'progress', n: 1 });
      push({ type: 'progress', n: 2 });
      push({ type: 'complete', result: 'ok' });
    });
    const events = await collectAll(stream.events);
    expect(events).toEqual([
      { type: 'progress', n: 1 },
      { type: 'progress', n: 2 },
      { type: 'complete', result: 'ok' },
    ]);
  });

  test('consumer iterates BEFORE producer pushes — first next() awaits, then resolves', async () => {
    let pushFn: ((e: TestEvent) => void) | null = null;
    const stream = createBufferedAsyncStream<TestEvent>((push) => {
      pushFn = push;
    });
    const iter = stream.events[Symbol.asyncIterator]();
    const pending = iter.next();

    // Push happens AFTER the consumer has parked as a waiter.
    setTimeout(() => {
      pushFn?.({ type: 'progress', n: 1 });
      pushFn?.({ type: 'complete', result: 'ok' });
    }, 10);

    const first = await pending;
    expect(first.value).toEqual({ type: 'progress', n: 1 });
    const second = await iter.next();
    expect(second.value).toEqual({ type: 'complete', result: 'ok' });
    const done = await iter.next();
    expect(done.done).toBe(true);
  });

  test('iteration ends after a complete event — late events are discarded', async () => {
    let pushFn: ((e: TestEvent) => void) | null = null;
    const stream = createBufferedAsyncStream<TestEvent>((push) => {
      pushFn = push;
    });
    pushFn?.({ type: 'progress', n: 1 });
    pushFn?.({ type: 'complete', result: 'ok' });
    pushFn?.({ type: 'progress', n: 99 }); // late — should be dropped
    pushFn?.({ type: 'complete', result: 'duplicate' }); // late — should be dropped

    const events = await collectAll(stream.events);
    expect(events).toEqual([
      { type: 'progress', n: 1 },
      { type: 'complete', result: 'ok' },
    ]);
  });

  test('iteration ends after an error event — same termination semantics as complete', async () => {
    const stream = createBufferedAsyncStream<TestEvent>((push) => {
      push({ type: 'progress', n: 1 });
      push({ type: 'error', message: 'boom' });
      push({ type: 'progress', n: 2 }); // dropped
    });
    const events = await collectAll(stream.events);
    expect(events).toEqual([
      { type: 'progress', n: 1 },
      { type: 'error', message: 'boom' },
    ]);
  });

  test('terminal event aborts the producer signal (cheaply ends in-flight reads)', async () => {
    let capturedSignal: AbortSignal | null = null;
    const stream = createBufferedAsyncStream<TestEvent>((push, signal) => {
      capturedSignal = signal;
      push({ type: 'complete', result: 'ok' });
    });
    expect(capturedSignal?.aborted).toBe(true);
    void stream;
  });

  test('external cancel() aborts the signal and ends the iterator', async () => {
    let capturedSignal: AbortSignal | null = null;
    const stream = createBufferedAsyncStream<TestEvent>((_push, signal) => {
      capturedSignal = signal;
    });
    expect(capturedSignal?.aborted).toBe(false);

    const iter = stream.events[Symbol.asyncIterator]();
    const pending = iter.next();
    stream.cancel();

    expect(capturedSignal?.aborted).toBe(true);
    const result = await pending;
    expect(result.done).toBe(true);
  });

  test('cancel() after a terminal event is a no-op (idempotent)', async () => {
    let abortCount = 0;
    const stream = createBufferedAsyncStream<TestEvent>((push, signal) => {
      signal.addEventListener('abort', () => {
        abortCount++;
      });
      push({ type: 'complete', result: 'ok' });
    });
    // Already aborted by the terminal push.
    expect(abortCount).toBe(1);
    stream.cancel();
    stream.cancel();
    expect(abortCount).toBe(1);
  });

  test('cancel() before any consumer iteration still drains', async () => {
    const stream = createBufferedAsyncStream<TestEvent>(() => {
      // Producer never pushes anything.
    });
    stream.cancel();
    const events = await collectAll(stream.events);
    expect(events).toEqual([]);
  });

  test('multiple consumer next() calls all park as waiters and drain on terminate', async () => {
    let pushFn: ((e: TestEvent) => void) | null = null;
    const stream = createBufferedAsyncStream<TestEvent>((push) => {
      pushFn = push;
    });
    const iter = stream.events[Symbol.asyncIterator]();
    // Park two waiters before any push.
    const p1 = iter.next();
    const p2 = iter.next();
    pushFn?.({ type: 'progress', n: 1 });
    pushFn?.({ type: 'complete', result: 'ok' });

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.value).toEqual({ type: 'progress', n: 1 });
    expect(r2.value).toEqual({ type: 'complete', result: 'ok' });
    // Subsequent next() reports done.
    const r3 = await iter.next();
    expect(r3.done).toBe(true);
  });

  test('producer signal can be wired to fetch — abort ends a pending read', async () => {
    // Simulates the HTTP transport's pattern: producer awaits a fake
    // long-running operation, signal abort throws AbortError, producer
    // returns silently.
    let producerExitedCleanly = false;
    let pushFn: ((e: TestEvent) => void) | null = null;

    const stream = createBufferedAsyncStream<TestEvent>((push, signal) => {
      pushFn = push;
      void (async () => {
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            producerExitedCleanly = true;
            return;
          }
          throw err;
        }
      })();
    });

    pushFn?.({ type: 'complete', result: 'ok' });
    const events = await collectAll(stream.events);
    expect(events).toEqual([{ type: 'complete', result: 'ok' }]);
    // Yield to event loop so the producer's abort handler fires.
    await new Promise((r) => setTimeout(r, 10));
    expect(producerExitedCleanly).toBe(true);
  });
});
