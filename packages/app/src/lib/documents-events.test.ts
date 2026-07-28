import { afterEach, describe, expect, test } from 'vitest';
import { emitDocumentsChanged, subscribeToDocumentsChanged } from './documents-events';

const originalWindow = globalThis.window;

type Listener = (event: Event) => void;

function installFakeWindow() {
  const listeners = new Map<string, Set<Listener>>();
  const fakeWindow = {
    addEventListener(type: string, listener: Listener) {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
    writable: true,
  });

  return fakeWindow;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
    writable: true,
  });
});

describe('documents changed event bridge', () => {
  test('deduplicates emitted channels for subscribers', () => {
    installFakeWindow();
    const received: unknown[] = [];
    const unsubscribe = subscribeToDocumentsChanged((channels) => received.push(channels));

    emitDocumentsChanged(['files', 'files', 'graph']);

    unsubscribe();
    expect(received).toEqual([['files', 'graph']]);
  });

  test('defaults missing channels to files for legacy app-local events', () => {
    const fakeWindow = installFakeWindow();
    const received: unknown[] = [];
    subscribeToDocumentsChanged((channels) => received.push(channels));

    fakeWindow.dispatchEvent(new CustomEvent('open-knowledge:documents-changed'));

    expect(received).toEqual([['files']]);
  });

  test('filters malformed channels without throwing', () => {
    const fakeWindow = installFakeWindow();
    const received: unknown[] = [];
    subscribeToDocumentsChanged((channels) => received.push(channels));

    fakeWindow.dispatchEvent(
      new CustomEvent('open-knowledge:documents-changed', {
        detail: { channels: ['files', 'bogus', 1, 'backlinks'] },
      }),
    );

    expect(received).toEqual([['files', 'backlinks']]);
  });
});
