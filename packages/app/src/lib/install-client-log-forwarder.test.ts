import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  RENDERER_LOG_MAX_BATCH_BYTES,
  RENDERER_LOG_MAX_ENTRIES,
} from '@inkeep/open-knowledge-core';
import {
  type ClientLogForwarderHandle,
  installClientLogForwarder,
} from './install-client-log-forwarder';

// The forwarder reads `console` / `window` / `document` through injectable
// seams, so these unit tests run in the plain (non-DOM) tier with fakes — no
// jsdom, fully deterministic.

let handle: ClientLogForwarderHandle | undefined;
afterEach(() => {
  handle?.uninstall();
  handle = undefined;
});

type ConsoleLike = Record<'log' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>;

function makeFakeConsole() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const mk =
    (method: string) =>
    (...args: unknown[]) =>
      calls.push({ method, args });
  const obj: ConsoleLike & { calls: typeof calls } = {
    calls,
    log: mk('log'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
  };
  return obj;
}

function makeFakeWindow(opts: { okDesktop?: unknown; fetchImpl?: typeof fetch } = {}) {
  const listeners = new Map<string, (event: Event) => void>();
  return {
    okDesktop: opts.okDesktop,
    fetch: (opts.fetchImpl ??
      (() => Promise.resolve(new Response(null, { status: 200 })))) as typeof fetch,
    addEventListener(type: string, listener: (event: Event) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
    emit(type: string) {
      listeners.get(type)?.(new Event(type));
    },
  };
}

function makeFakeDocument(visibilityState = 'visible') {
  const listeners = new Map<string, () => void>();
  return {
    visibilityState,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
    emit(type: string) {
      listeners.get(type)?.();
    },
  };
}

function makeFetchSpy() {
  return mock((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
}

function bodyOf(spy: ReturnType<typeof makeFetchSpy>): { entries: Array<Record<string, unknown>> } {
  const call = spy.mock.calls.at(-1);
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

function install(
  fetchSpy: ReturnType<typeof makeFetchSpy>,
  con = makeFakeConsole(),
  win = makeFakeWindow(),
  doc = makeFakeDocument(),
) {
  handle = installClientLogForwarder({
    fetchImpl: fetchSpy,
    flushIntervalMs: 100_000,
    consoleObj: con,
    windowObj: win,
    documentObj: doc,
    now: () => 111,
  });
  return { con, win, doc };
}

describe('installClientLogForwarder', () => {
  test('no-op when no window is available', () => {
    // No windowObj injected + no global window in the unit-test tier.
    expect(installClientLogForwarder({ fetchImpl: makeFetchSpy() })).toBeUndefined();
  });

  test('no-op inside Electron (window.okDesktop present)', () => {
    const fetchSpy = makeFetchSpy();
    const con = makeFakeConsole();
    handle = installClientLogForwarder({
      fetchImpl: fetchSpy,
      consoleObj: con,
      windowObj: makeFakeWindow({ okDesktop: {} }),
      documentObj: makeFakeDocument(),
    });
    expect(handle).toBeUndefined();
    con.warn('not captured'); // console not patched
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('captures a structured console.warn and flushes the lifted event + fields', () => {
    const fetchSpy = makeFetchSpy();
    const { con } = install(fetchSpy);
    con.warn(
      JSON.stringify({
        event: 'ok-provider-server-driven-close-reauth',
        reason: 'Failed to connect',
      }),
    );
    handle?.flushNow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { entries } = bodyOf(fetchSpy);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.event).toBe('ok-provider-server-driven-close-reauth');
    expect((entries[0]?.fields as Record<string, unknown>)?.reason).toBe('Failed to connect');
    expect(entries[0]?.ts).toBe(111);
  });

  test('still calls the original console method', () => {
    const fetchSpy = makeFetchSpy();
    const { con } = install(fetchSpy);
    con.warn('hello');
    expect((con as ReturnType<typeof makeFakeConsole>).calls).toContainEqual({
      method: 'warn',
      args: ['hello'],
    });
  });

  test('maps log/info/warn/error to info/info/warn/error', () => {
    const fetchSpy = makeFetchSpy();
    const { con } = install(fetchSpy);
    con.log('a');
    con.info('b');
    con.warn('c');
    con.error('d');
    handle?.flushNow();
    expect(bodyOf(fetchSpy).entries.map((e) => e.level)).toEqual(['info', 'info', 'warn', 'error']);
  });

  test('re-entrancy guard: a console call during flush does not recurse', () => {
    let conRef: ConsoleLike | undefined;
    const fetchSpy = mock((_url: string, _init?: RequestInit) => {
      conRef?.error('error raised while flushing'); // transitive console during flush
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const { con } = install(fetchSpy);
    conRef = con;
    con.warn('trigger');
    handle?.flushNow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('flushes early at the entry cap', () => {
    const fetchSpy = makeFetchSpy();
    const { con } = install(fetchSpy);
    for (let i = 0; i < RENDERER_LOG_MAX_ENTRIES; i++) con.info(`m${i}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('flushes early at the byte budget (well under the entry cap)', () => {
    const fetchSpy = makeFetchSpy();
    const { con } = install(fetchSpy);
    const big = 'x'.repeat(8000);
    const needed = Math.ceil(RENDERER_LOG_MAX_BATCH_BYTES / 8000) + 1;
    expect(needed).toBeLessThan(RENDERER_LOG_MAX_ENTRIES);
    for (let i = 0; i < needed; i++) con.warn(big);
    expect(fetchSpy).toHaveBeenCalled();
  });

  test('flushes on pagehide', () => {
    const fetchSpy = makeFetchSpy();
    const { con, win } = install(fetchSpy);
    con.warn('before unload');
    win.emit('pagehide');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('flushes on visibilitychange when hidden', () => {
    const fetchSpy = makeFetchSpy();
    const con = makeFakeConsole();
    const win = makeFakeWindow();
    const doc = makeFakeDocument('hidden');
    install(fetchSpy, con, win, doc);
    con.warn('going hidden');
    doc.emit('visibilitychange');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('captures window error and unhandledrejection as error-level entries', () => {
    const fetchSpy = makeFetchSpy();
    const { win } = install(fetchSpy);
    win.emit('error');
    win.emit('unhandledrejection');
    handle?.flushNow();
    const levels = bodyOf(fetchSpy).entries.map((e) => e.level);
    expect(levels).toEqual(['error', 'error']);
  });

  test('drops oversized structured fields but keeps the event + message', () => {
    const fetchSpy = makeFetchSpy();
    const { con } = install(fetchSpy);
    con.warn(JSON.stringify({ event: 'big-event', big: 'y'.repeat(9000) }));
    handle?.flushNow();
    const entry = bodyOf(fetchSpy).entries[0];
    expect(entry?.event).toBe('big-event');
    expect(entry?.fields).toBeUndefined();
    expect((entry?.message as string).length).toBeLessThanOrEqual(8192);
  });

  test('uninstall restores console and clears the marker (fresh install works)', () => {
    const fetchSpy = makeFetchSpy();
    const con = makeFakeConsole();
    const win = makeFakeWindow();
    const h1 = installClientLogForwarder({
      fetchImpl: fetchSpy,
      consoleObj: con,
      windowObj: win,
      documentObj: makeFakeDocument(),
    });
    expect(h1).toBeDefined();
    h1?.uninstall();
    // Console restored: capturing no longer happens.
    con.warn('after uninstall');
    h1?.flushNow();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Marker cleared: a second install on the same window succeeds.
    handle = installClientLogForwarder({
      fetchImpl: fetchSpy,
      consoleObj: con,
      windowObj: win,
      documentObj: makeFakeDocument(),
    });
    expect(handle).toBeDefined();
  });
});
