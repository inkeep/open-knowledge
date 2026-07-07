/**
 * Unit tests for `createBranchStore` — exercised directly with stub deps to
 * isolate the cache + listener machinery from the production singleton's
 * window-scoped event channel.
 */
import { describe, expect, mock, test } from 'bun:test';
import { createBranchStore } from './current-branch-store';

function makeEventStub(): {
  subscribeToEvent: (cb: (branch: string | null) => void) => () => void;
  emit: (branch: string | null) => void;
} {
  let callback: ((branch: string | null) => void) | null = null;
  return {
    subscribeToEvent: (cb) => {
      callback = cb;
      return () => {
        callback = null;
      };
    },
    emit: (branch) => callback?.(branch),
  };
}

describe('createBranchStore', () => {
  test('initial snapshot is null before any subscription', () => {
    const events = makeEventStub();
    const store = createBranchStore({
      fetchBranch: () => Promise.resolve('main'),
      subscribeToEvent: events.subscribeToEvent,
    });
    expect(store.getSnapshot()).toBeNull();
  });

  test('first subscribe triggers exactly one bootstrap fetch', async () => {
    const events = makeEventStub();
    const fetchBranch = mock(() => Promise.resolve('main'));
    const store = createBranchStore({ fetchBranch, subscribeToEvent: events.subscribeToEvent });

    const listener = mock(() => {});
    store.subscribe(listener);
    store.subscribe(listener);
    store.subscribe(listener);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchBranch).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe('main');
  });

  test('event emission updates snapshot and notifies listeners', () => {
    const events = makeEventStub();
    const store = createBranchStore({
      fetchBranch: () => Promise.resolve(null),
      subscribeToEvent: events.subscribeToEvent,
    });
    const listener = mock(() => {});
    store.subscribe(listener);

    events.emit('feature-x');
    expect(store.getSnapshot()).toBe('feature-x');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('duplicate-value emission does not notify (equality dedupe)', () => {
    const events = makeEventStub();
    const store = createBranchStore({
      fetchBranch: () => Promise.resolve(null),
      subscribeToEvent: events.subscribeToEvent,
    });
    const listener = mock(() => {});
    store.subscribe(listener);

    events.emit('main');
    events.emit('main');
    events.emit('main');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('unsubscribe stops notifications', () => {
    const events = makeEventStub();
    const store = createBranchStore({
      fetchBranch: () => Promise.resolve(null),
      subscribeToEvent: events.subscribeToEvent,
    });
    const listener = mock(() => {});
    const unsub = store.subscribe(listener);

    events.emit('first');
    unsub();
    events.emit('second');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe('second');
  });

  test('bootstrap fetch rejection is swallowed; later event still wins', async () => {
    const events = makeEventStub();
    const store = createBranchStore({
      fetchBranch: () => Promise.reject(new Error('network down')),
      subscribeToEvent: events.subscribeToEvent,
    });
    store.subscribe(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot()).toBeNull();
    events.emit('main');
    expect(store.getSnapshot()).toBe('main');
  });
});
