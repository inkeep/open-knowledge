import { afterEach, describe, expect, test } from 'vitest';
import { emitCreateTopLevelFile, subscribeToCreateTopLevelFile } from './create-file-events';

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

describe('create-file event bridge', () => {
  test('subscriber receives the emitted request', () => {
    installFakeWindow();
    let calls = 0;
    const unsubscribe = subscribeToCreateTopLevelFile(() => {
      calls += 1;
    });

    emitCreateTopLevelFile();
    emitCreateTopLevelFile();

    unsubscribe();
    expect(calls).toBe(2);
  });

  test('unsubscribe stops further deliveries', () => {
    installFakeWindow();
    let calls = 0;
    const unsubscribe = subscribeToCreateTopLevelFile(() => {
      calls += 1;
    });

    emitCreateTopLevelFile();
    unsubscribe();
    emitCreateTopLevelFile();

    expect(calls).toBe(1);
  });

  test('multiple subscribers all fire on a single emit', () => {
    installFakeWindow();
    const received: string[] = [];
    const offA = subscribeToCreateTopLevelFile(() => received.push('a'));
    const offB = subscribeToCreateTopLevelFile(() => received.push('b'));

    emitCreateTopLevelFile();

    offA();
    offB();
    expect(received.sort()).toEqual(['a', 'b']);
  });

  test('default emit delivers an empty request (initialDir + template absent)', () => {
    installFakeWindow();
    const received: Array<{ initialDir?: string; template?: { folder: string; name: string } }> =
      [];
    const off = subscribeToCreateTopLevelFile((req) => received.push(req));

    emitCreateTopLevelFile();
    off();

    expect(received).toEqual([{}]);
  });

  test('initialDir is forwarded verbatim to subscribers', () => {
    installFakeWindow();
    const received: Array<{ initialDir?: string }> = [];
    const off = subscribeToCreateTopLevelFile((req) => received.push(req));

    emitCreateTopLevelFile({ initialDir: 'meetings' });
    off();

    expect(received[0]?.initialDir).toBe('meetings');
  });

  test('folder creation requests preserve their item kind', () => {
    installFakeWindow();
    const received: Array<{ initialDir?: string; kind?: 'file' | 'folder' }> = [];
    const off = subscribeToCreateTopLevelFile((request) => received.push(request));

    emitCreateTopLevelFile({ initialDir: 'reports', kind: 'folder' });
    off();

    expect(received).toEqual([{ initialDir: 'reports', kind: 'folder' }]);
  });

  test('template payload is forwarded verbatim (folder + name)', () => {
    installFakeWindow();
    const received: Array<{ template?: { folder: string; name: string } }> = [];
    const off = subscribeToCreateTopLevelFile((req) => received.push(req));

    emitCreateTopLevelFile({ template: { folder: 'specs', name: 'spec' } });
    off();

    expect(received[0]?.template).toEqual({ folder: 'specs', name: 'spec' });
  });
});
