
interface BufferedAsyncStreamHandle<E> {
  readonly events: AsyncIterable<E>;
  cancel(): void;
}

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
