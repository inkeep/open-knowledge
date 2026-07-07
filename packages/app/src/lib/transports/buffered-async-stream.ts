/**
 * Single-producer / single-consumer queue exposed as an `AsyncIterable`.
 *
 * The local-op transports need to bridge a push-style producer (NDJSON
 * fetch reader, IPC event listener) and a pull-style consumer (the React
 * component's `await iter.next()` loop). Producer and consumer run at
 * different speeds, so we buffer events that arrive before consumption
 * and park `next()` callers as `waiters` when the buffer is empty.
 *
 * The producer side receives an `AbortSignal` that fires when either
 *   (a) the consumer calls `cancel()`, or
 *   (b) a terminal `complete` / `error` event was pushed.
 * Wiring the signal into `fetch({ signal })` cheaply ends in-flight reads
 * once the stream is logically done — avoids draining the rest of the
 * response body just to discard it.
 */

interface BufferedAsyncStreamHandle<E> {
  readonly events: AsyncIterable<E>;
  /** Cancel the in-flight flow. Idempotent. */
  cancel(): void;
}

/**
 * Create a buffered async-iterable stream. The `start` callback is invoked
 * synchronously and owns the producer side: call `push` for each event,
 * and respect `signal` to short-circuit work once the stream terminates.
 *
 * Events whose `type` is `'complete'` or `'error'` are treated as terminal
 * — pushing one aborts the signal and drains pending consumers.
 */
export function createBufferedAsyncStream<E extends { type: string }>(
  start: (push: (event: E) => void, signal: AbortSignal) => void,
): BufferedAsyncStreamHandle<E> {
  const buffer: E[] = [];
  const waiters: ((event: E | null) => void)[] = [];
  const ac = new AbortController();
  let terminated = false;

  const drainWaiters = (): void => {
    for (const w of waiters.splice(0)) w(null);
  };

  const push = (event: E): void => {
    if (terminated) return;
    if (waiters.length > 0) {
      waiters.shift()?.(event);
    } else {
      buffer.push(event);
    }
    if (event.type === 'complete' || event.type === 'error') {
      terminated = true;
      ac.abort();
      drainWaiters();
    }
  };

  start(push, ac.signal);

  const events: AsyncIterable<E> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<E>> {
          if (buffer.length > 0) {
            const value = buffer.shift();
            if (value === undefined) return { value: undefined, done: true };
            return { value, done: false };
          }
          if (terminated) return { value: undefined, done: true };
          return new Promise<IteratorResult<E>>((resolve) => {
            waiters.push((event) => {
              if (event === null) resolve({ value: undefined, done: true });
              else resolve({ value: event, done: false });
            });
          });
        },
      };
    },
  };

  return {
    events,
    cancel: () => {
      if (terminated) return;
      terminated = true;
      ac.abort();
      drainWaiters();
    },
  };
}
