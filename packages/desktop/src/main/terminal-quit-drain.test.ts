import { describe, expect, test, vi } from 'vitest';
import { createTerminalQuitDrain } from './terminal-quit-drain.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('createTerminalQuitDrain', () => {
  test('defers quit re-entry until after the terminal drain and native event turn', async () => {
    const drain = deferred<void>();
    const deferredCallbacks: Array<() => void> = [];
    const resumeQuit = vi.fn();
    const onWillQuit = createTerminalQuitDrain({
      defer: (callback) => deferredCallbacks.push(callback),
      drain: () => drain.promise,
      resumeQuit,
    });
    const event = { preventDefault: vi.fn() };

    expect(onWillQuit(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(resumeQuit).not.toHaveBeenCalled();

    drain.resolve();
    await drain.promise;
    await Promise.resolve();

    expect(resumeQuit).not.toHaveBeenCalled();
    expect(deferredCallbacks).toHaveLength(1);
    deferredCallbacks[0]?.();
    expect(resumeQuit).toHaveBeenCalledOnce();

    const reentrantEvent = { preventDefault: vi.fn() };
    expect(onWillQuit(reentrantEvent)).toBe(false);
    expect(reentrantEvent.preventDefault).not.toHaveBeenCalled();
  });

  test('coalesces repeated will-quit events while the drain is pending', () => {
    const drain = deferred<void>();
    const drainTerminals = vi.fn(() => drain.promise);
    const onWillQuit = createTerminalQuitDrain({
      defer: vi.fn(),
      drain: drainTerminals,
      resumeQuit: vi.fn(),
    });
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    expect(onWillQuit(firstEvent)).toBe(true);
    expect(onWillQuit(secondEvent)).toBe(true);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(drainTerminals).toHaveBeenCalledOnce();
  });

  test('resumes quit after a rejected best-effort drain', async () => {
    const drain = deferred<void>();
    const deferredCallbacks: Array<() => void> = [];
    const resumeQuit = vi.fn();
    const onWillQuit = createTerminalQuitDrain({
      defer: (callback) => deferredCallbacks.push(callback),
      drain: () => drain.promise,
      resumeQuit,
    });

    expect(onWillQuit({ preventDefault: vi.fn() })).toBe(true);
    drain.reject(new Error('drain failed'));
    await drain.promise.catch(() => undefined);
    await Promise.resolve();

    expect(deferredCallbacks).toHaveLength(1);
    deferredCallbacks[0]?.();
    expect(resumeQuit).toHaveBeenCalledOnce();
  });
});
