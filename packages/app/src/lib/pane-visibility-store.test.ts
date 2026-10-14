import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneId,
  type PaneVisibility,
  type PaneVisibilityRequest,
  type PaneVisibilitySnapshot,
  paneVisibilityStore,
} from './pane-visibility-store';

const HIDDEN: PaneVisibility = { open: false, onScreen: false };
const SHOWN: PaneVisibility = { open: true, onScreen: true };
const OPEN_OFF_SCREEN: PaneVisibility = { open: true, onScreen: false };

afterEach(() => {
  __resetPaneVisibilityStoreForTests();
  vi.unstubAllGlobals();
});

function recordingStandIn(name: string, touched: string[]): object {
  return new Proxy(
    {},
    {
      get(_target, key) {
        touched.push(`${name}.${String(key)}`);
        return () => undefined;
      },
    },
  );
}

describe('pane-visibility-store', () => {
  test('starts with no pane known to exist', () => {
    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: null,
      agents: null,
      terminal: null,
    });
  });

  test('a changed publish replaces the snapshot and notifies every subscriber exactly once', () => {
    const seenA: PaneVisibilitySnapshot[] = [];
    const seenB: PaneVisibilitySnapshot[] = [];
    paneVisibilityStore.subscribe(() => seenA.push(paneVisibilityStore.getSnapshot()));
    paneVisibilityStore.subscribe(() => seenB.push(paneVisibilityStore.getSnapshot()));

    const next: PaneVisibilitySnapshot = { editor: null, agents: SHOWN, terminal: HIDDEN };
    paneVisibilityStore.publish(next);

    expect(paneVisibilityStore.getSnapshot()).toEqual(next);
    expect(seenA).toEqual([next]);
    expect(seenB).toEqual([next]);
  });

  test.each<[string, PaneVisibilitySnapshot, PaneVisibilitySnapshot]>([
    [
      'agents opens',
      { editor: null, agents: HIDDEN, terminal: null },
      { editor: null, agents: SHOWN, terminal: null },
    ],
    [
      'agents goes off screen while open',
      { editor: null, agents: SHOWN, terminal: null },
      { editor: null, agents: OPEN_OFF_SCREEN, terminal: null },
    ],
    [
      'terminal starts existing',
      { editor: null, agents: HIDDEN, terminal: null },
      { editor: null, agents: HIDDEN, terminal: HIDDEN },
    ],
    [
      'terminal stops existing',
      { editor: null, agents: HIDDEN, terminal: SHOWN },
      { editor: null, agents: HIDDEN, terminal: null },
    ],
    [
      'terminal closes',
      { editor: null, agents: HIDDEN, terminal: SHOWN },
      { editor: null, agents: HIDDEN, terminal: HIDDEN },
    ],
    [
      'agents stops existing',
      { editor: null, agents: HIDDEN, terminal: null },
      { editor: null, agents: null, terminal: null },
    ],
    [
      'editor starts existing',
      { editor: null, agents: HIDDEN, terminal: null },
      { editor: SHOWN, agents: HIDDEN, terminal: null },
    ],
    [
      'editor hides',
      { editor: SHOWN, agents: HIDDEN, terminal: null },
      { editor: HIDDEN, agents: HIDDEN, terminal: null },
    ],
  ])('publishing a snapshot where %s notifies once', (_label, before, after) => {
    paneVisibilityStore.publish(before);
    let calls = 0;
    paneVisibilityStore.subscribe(() => {
      calls += 1;
    });

    paneVisibilityStore.publish(after);

    expect(calls).toBe(1);
    expect(paneVisibilityStore.getSnapshot()).toEqual(after);
  });

  test('a value-equal publish notifies nobody and keeps the snapshot identity', () => {
    paneVisibilityStore.publish({
      editor: null,
      agents: { ...OPEN_OFF_SCREEN },
      terminal: { ...HIDDEN },
    });
    const before = paneVisibilityStore.getSnapshot();
    let calls = 0;
    paneVisibilityStore.subscribe(() => {
      calls += 1;
    });

    paneVisibilityStore.publish({
      editor: null,
      agents: { ...OPEN_OFF_SCREEN },
      terminal: { ...HIDDEN },
    });

    expect(calls).toBe(0);
    expect(paneVisibilityStore.getSnapshot()).toBe(before);
  });

  test('a publish that changes only exclusivity updates it and notifies subscribers once', () => {
    const snapshot: PaneVisibilitySnapshot = { editor: SHOWN, agents: HIDDEN, terminal: null };
    paneVisibilityStore.publish(snapshot, false);
    let calls = 0;
    paneVisibilityStore.subscribe(() => {
      calls += 1;
    });

    paneVisibilityStore.publish({ ...snapshot }, true);

    expect(paneVisibilityStore.isExclusive()).toBe(true);
    expect(calls).toBe(1);
  });

  test('publishing the initial empty snapshot again notifies nobody', () => {
    let calls = 0;
    paneVisibilityStore.subscribe(() => {
      calls += 1;
    });

    paneVisibilityStore.publish({ editor: null, agents: null, terminal: null });

    expect(calls).toBe(0);
  });

  test('a request reaches every request handler before any snapshot is published', () => {
    const seenA: PaneVisibilityRequest[] = [];
    const seenB: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((r) => seenA.push(r));
    paneVisibilityStore.subscribeRequests((r) => seenB.push(r));

    paneVisibilityStore.request('agents', false);

    expect(seenA).toEqual([{ pane: 'agents', open: false }]);
    expect(seenB).toEqual([{ pane: 'agents', open: false }]);
  });

  test('requests carry the pane and the wanted state in order', () => {
    const sent: Array<[PaneId, boolean]> = [
      ['terminal', true],
      ['agents', true],
      ['terminal', false],
      ['agents', false],
    ];
    const seen: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((r) => seen.push(r));

    for (const [pane, open] of sent) paneVisibilityStore.request(pane, open);

    expect(seen).toEqual([
      { pane: 'terminal', open: true },
      { pane: 'agents', open: true },
      { pane: 'terminal', open: false },
      { pane: 'agents', open: false },
    ]);
  });

  test('a request made before any handler subscribes is handed to the first handler, once', () => {
    paneVisibilityStore.request('editor', true);
    const first: PaneVisibilityRequest[] = [];
    const second: PaneVisibilityRequest[] = [];

    paneVisibilityStore.subscribeRequests((r) => first.push(r));
    paneVisibilityStore.subscribeRequests((r) => second.push(r));

    expect(first).toEqual([{ pane: 'editor', open: true }]);
    expect(second).toEqual([]);
  });

  test('a reset drops a request still waiting for a handler', () => {
    paneVisibilityStore.request('editor', true);
    __resetPaneVisibilityStoreForTests();
    const seen: PaneVisibilityRequest[] = [];

    paneVisibilityStore.subscribeRequests((r) => seen.push(r));

    expect(seen).toEqual([]);
  });

  test('a request neither changes the snapshot nor notifies snapshot subscribers', () => {
    const before = paneVisibilityStore.getSnapshot();
    let calls = 0;
    paneVisibilityStore.subscribe(() => {
      calls += 1;
    });
    const seen: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((r) => seen.push(r));

    paneVisibilityStore.request('agents', true);

    expect(seen).toHaveLength(1);
    expect(calls).toBe(0);
    expect(paneVisibilityStore.getSnapshot()).toBe(before);
  });

  test('an unsubscribed snapshot listener receives nothing further', () => {
    let calls = 0;
    const stop = paneVisibilityStore.subscribe(() => {
      calls += 1;
    });
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
    expect(calls).toBe(1);

    stop();
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });

    expect(calls).toBe(1);
  });

  test('an unsubscribed request handler receives nothing further', () => {
    const kept: PaneVisibilityRequest[] = [];
    const dropped: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((r) => kept.push(r));
    const stop = paneVisibilityStore.subscribeRequests((r) => dropped.push(r));
    paneVisibilityStore.request('agents', true);

    stop();
    paneVisibilityStore.request('agents', false);

    expect(dropped).toEqual([{ pane: 'agents', open: true }]);
    expect(kept).toEqual([
      { pane: 'agents', open: true },
      { pane: 'agents', open: false },
    ]);
  });

  test('the methods work detached from the store, as useSyncExternalStore and effects call them', () => {
    const { getSnapshot, subscribe, publish, request, subscribeRequests } = paneVisibilityStore;
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });
    const seen: PaneVisibilityRequest[] = [];
    subscribeRequests((r) => seen.push(r));

    publish({ editor: null, agents: SHOWN, terminal: null });
    request('terminal', true);

    expect(calls).toBe(1);
    expect(getSnapshot()).toEqual({ editor: null, agents: SHOWN, terminal: null });
    expect(seen).toEqual([{ pane: 'terminal', open: true }]);
  });

  test('publishing and requesting touch neither browser storage nor the desktop bridge', () => {
    const touched: string[] = [];
    const storage = recordingStandIn('localStorage', touched);
    const okDesktop = recordingStandIn('okDesktop', touched);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', recordingStandIn('sessionStorage', touched));
    vi.stubGlobal('window', { okDesktop, localStorage: storage });
    expect(globalThis.localStorage).toBe(storage);

    paneVisibilityStore.subscribe(() => {});
    paneVisibilityStore.subscribeRequests(() => {});
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: OPEN_OFF_SCREEN });
    paneVisibilityStore.request('terminal', false);
    paneVisibilityStore.request('agents', true);
    paneVisibilityStore.getSnapshot();

    expect(touched).toEqual([]);
  });
});
