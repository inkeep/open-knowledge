import * as actualSonner from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

const toastLoading = vi.fn((_msg: string, _opts?: unknown) => 'loading-id');
const toastError = vi.fn((_msg: string, _opts?: unknown) => 'error-id');
const toastDismiss = vi.fn((_id?: unknown) => {});
const toastCustom = vi.fn((_render: (id: unknown) => unknown, _opts?: unknown) => 'custom-id');
vi.doMock('sonner', () => ({
  ...actualSonner,
  toast: Object.assign(
    vi.fn(() => {}),
    {
      loading: toastLoading,
      error: toastError,
      dismiss: toastDismiss,
      custom: toastCustom,
    },
  ),
}));

type PromptModule = typeof import('@/lib/install-stale-tab-reload-prompt');
type SavedWorkResult = import('@/lib/install-stale-tab-reload-prompt').SavedWorkResult;
type StoreModule = typeof import('@/lib/server-version-store');
let installStaleTabReloadPrompt: PromptModule['installStaleTabReloadPrompt'];
let staleTabReloadBody: PromptModule['staleTabReloadBody'];
let staleTabReloadRefusal: PromptModule['staleTabReloadRefusal'];
let waitForSavedWork: PromptModule['waitForSavedWork'];
let STALE_TAB_RELOAD_TOAST_ID: PromptModule['STALE_TAB_RELOAD_TOAST_ID'];
let watchForSavedWork: PromptModule['watchForSavedWork'];
let observeServerVersion: StoreModule['observeServerVersion'];
let resetStore: StoreModule['__resetServerVersionStoreForTests'];
beforeAll(async () => {
  ({
    installStaleTabReloadPrompt,
    staleTabReloadBody,
    staleTabReloadRefusal,
    waitForSavedWork,
    STALE_TAB_RELOAD_TOAST_ID,
    watchForSavedWork,
  } = await import('@/lib/install-stale-tab-reload-prompt'));
  ({ observeServerVersion, __resetServerVersionStoreForTests: resetStore } = await import(
    '@/lib/server-version-store'
  ));
});

type PromptNode = {
  props: {
    body: string;
    detail: string;
    actionLabel: string;
    dismissLabel: string;
    onAction: () => void;
    onDismiss: () => void;
  };
};

function renderLastPrompt(): PromptNode {
  const render = toastCustom.mock.calls.at(-1)?.[0] as (id: unknown) => PromptNode;
  return render(STALE_TAB_RELOAD_TOAST_ID);
}

const loadedFrom = { runtimeVersion: '0.83.1', protocolVersion: 2 };
const upgraded = { runtimeVersion: '0.83.2', protocolVersion: 2 };
const flush = () => new Promise((r) => setTimeout(r, 0));

let cleanups: Array<() => void> = [];
type InstallOptions = Parameters<typeof installStaleTabReloadPrompt>[0];
function install(
  opts: Omit<InstallOptions, 'docNamesToOpen' | 'watchForSavedWork'> &
    Partial<Pick<InstallOptions, 'docNamesToOpen' | 'watchForSavedWork'>>,
) {
  const cleanup = installStaleTabReloadPrompt({
    docNamesToOpen: () => [],
    watchForSavedWork: () => () => {},
    ...opts,
  });
  if (cleanup) cleanups.push(cleanup);
  return cleanup;
}

beforeEach(() => {
  toastLoading.mockClear();
  toastError.mockClear();
  toastDismiss.mockClear();
  toastCustom.mockClear();
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  resetStore();
});

function workSource(opts: {
  unsynced: boolean;
  pendingReplay?: boolean;
  settled?: Promise<void>;
  recycleInFlightAfterSettle?: boolean;
}) {
  let unsynced = opts.unsynced;
  let pendingReplay = opts.pendingReplay ?? false;
  let recycleInFlight = opts.recycleInFlightAfterSettle ?? false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of listeners) cb();
  };
  return {
    source: {
      awaitMismatchSettled: () => opts.settled ?? Promise.resolve(),
      isMismatchRecycleInFlight: () => recycleInFlight,
      hasUnsavedWork: () => unsynced || pendingReplay,
      addUnsyncedWorkListener: (cb: () => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    finishSync: () => {
      unsynced = false;
      notify();
    },
    finishReplay: () => {
      pendingReplay = false;
      notify();
    },
    finishRecycle: () => {
      recycleInFlight = false;
      notify();
    },
    listenerCount: () => listeners.size,
  };
}

const PROMPT_DETAIL =
  'Reload this tab to bring it up to date. Your edits are saved before it reloads.';
const UNSAVED_REFUSAL =
  "Some edits haven't reached the server yet, so the tab didn't reload. Your edits are still here.";
const RECONNECTING_REFUSAL =
  "This tab is still reconnecting to OpenKnowledge, so it didn't reload. Try again in a moment.";
const UNCONFIRMED_REFUSAL =
  "This tab couldn't confirm that your edits are saved, so it didn't reload. Your edits are still here.";

function refusalWatch() {
  let onSaved: (() => void) | null = null;
  const stop = vi.fn();
  return {
    watchForSavedWork: (cb: () => void) => {
      onSaved = cb;
      return stop;
    },
    stop,
    started: () => onSaved !== null,
    saved: () => onSaved?.(),
  };
}

async function refuse(reason: SavedWorkResult, options: Partial<InstallOptions> = {}) {
  const watch = refusalWatch();
  const reload = vi.fn();
  install({
    bridge: undefined,
    waitForSavedWork: () => Promise.resolve(reason),
    watchForSavedWork: watch.watchForSavedWork,
    reload,
    ...options,
  });
  observeServerVersion(loadedFrom);
  observeServerVersion(upgraded);
  renderLastPrompt().props.onAction();
  await flush();
  return { watch, reload };
}

describe('stale tab reload prompt', () => {
  test('stays silent in the desktop app, which runs its own drift prompt', () => {
    const reload = vi.fn();
    const cleanup = install({
      bridge: {} as OkDesktopBridge,
      waitForSavedWork: () => Promise.resolve('saved'),
      reload,
    });

    observeServerVersion(loadedFrom);
    observeServerVersion(upgraded);

    expect(cleanup).toBeUndefined();
    expect(toastCustom).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a browser tab is prompted to reload when the server changes version', () => {
    install({
      bridge: undefined,
      waitForSavedWork: () => Promise.resolve('saved'),
      reload: vi.fn(),
    });

    observeServerVersion(loadedFrom);
    expect(toastCustom).not.toHaveBeenCalled();

    observeServerVersion(upgraded);

    expect(toastCustom).toHaveBeenCalledTimes(1);
    expect(toastCustom.mock.calls[0]?.[1]).toMatchObject({
      id: STALE_TAB_RELOAD_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
    });
    const node = renderLastPrompt();
    expect(node.props.body).toBe(
      'OpenKnowledge on this computer is now v0.83.2, but this tab is still running v0.83.1.',
    );
    expect(node.props.detail).toBe(PROMPT_DETAIL);
    expect(node.props.actionLabel).toBe('Reload');
  });

  test('a restart on the same version does not prompt', () => {
    install({
      bridge: undefined,
      waitForSavedWork: () => Promise.resolve('saved'),
      reload: vi.fn(),
    });

    observeServerVersion(loadedFrom);
    observeServerVersion({ ...loadedFrom });

    expect(toastCustom).not.toHaveBeenCalled();
  });

  test('Reload waits for unsaved edits to reach the server before reloading', async () => {
    let finishSaving: (result: SavedWorkResult) => void = () => {};
    const saving = new Promise<SavedWorkResult>((resolve) => {
      finishSaving = resolve;
    });
    const reload = vi.fn();
    install({ bridge: undefined, waitForSavedWork: () => saving, reload });
    observeServerVersion(loadedFrom);
    observeServerVersion(upgraded);

    renderLastPrompt().props.onAction();
    await flush();

    expect(toastDismiss).toHaveBeenCalledWith(STALE_TAB_RELOAD_TOAST_ID);
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    finishSaving('saved');
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a withheld reload puts its reason inside the prompt that comes back', async () => {
    const { reload, watch } = await refuse('unsaved');

    expect(reload).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastCustom).toHaveBeenCalledTimes(2);
    expect(toastCustom.mock.calls[1]?.[1]).toMatchObject({ id: STALE_TAB_RELOAD_TOAST_ID });
    const node = renderLastPrompt();
    expect(node.props.body).toBe(
      'OpenKnowledge on this computer is now v0.83.2, but this tab is still running v0.83.1.',
    );
    expect(node.props.detail).toBe(UNSAVED_REFUSAL);
    expect(watch.started()).toBe(true);
  });

  test('a reload withheld while the tab is still reconnecting says so instead of blaming edits', async () => {
    await refuse('reconnecting', { docNamesToOpen: () => ['notes'] });

    expect(renderLastPrompt().props.detail).toBe(RECONNECTING_REFUSAL);
  });

  test('a failure while checking for saved work withholds the reload and records why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reload = vi.fn();
      install({
        bridge: undefined,
        waitForSavedWork: () => Promise.reject(new TypeError('recovery threw')),
        reload,
      });
      observeServerVersion(loadedFrom);
      observeServerVersion(upgraded);

      renderLastPrompt().props.onAction();
      await flush();

      expect(reload).not.toHaveBeenCalled();
      expect(toastDismiss).toHaveBeenCalledWith('loading-id');
      expect(renderLastPrompt().props.detail).toBe(UNCONFIRMED_REFUSAL);
      const logged = warn.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(logged).toContainEqual({
        event: 'ok-stale-tab-reload-withheld',
        reason: 'unconfirmed',
        docsToOpenCount: 0,
        errorName: 'TypeError',
        errorMessage: 'recovery threw',
      });
    } finally {
      warn.mockRestore();
    }
  });

  test('a failed check keeps its reason even though nothing is left unsaved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const work = workSource({ unsynced: false });
      install({
        bridge: undefined,
        waitForSavedWork: () => Promise.reject(new Error('recycle threw')),
        watchForSavedWork: (onSaved) => watchForSavedWork(work.source, onSaved),
        reload: vi.fn(),
      });
      observeServerVersion(loadedFrom);
      observeServerVersion(upgraded);

      renderLastPrompt().props.onAction();
      await flush();
      await flush();

      expect(renderLastPrompt().props.detail).toBe(UNCONFIRMED_REFUSAL);
      expect(work.listenerCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test('a withheld reload names the unopened documents holding unsaved edits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await refuse('unsaved', { docNamesToOpen: () => ['notes', 'plans/q4'] });

      expect(renderLastPrompt().props.detail).toBe(
        'Some edits haven\'t reached the server yet, so the tab didn\'t reload. Open "notes" and "plans/q4" to save them, then reload.',
      );
      const logged = warn.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(logged).toContainEqual({
        event: 'ok-stale-tab-reload-withheld',
        reason: 'unsaved',
        docsToOpenCount: 2,
      });
    } finally {
      warn.mockRestore();
    }
  });

  test('the reason goes back to the usual prompt once the edits are saved', async () => {
    const { watch } = await refuse('unsaved');

    watch.saved();

    expect(toastCustom).toHaveBeenCalledTimes(3);
    expect(renderLastPrompt().props.detail).toBe(PROMPT_DETAIL);
  });

  test('Not now on a withheld reload stops watching for saved edits', async () => {
    const { watch } = await refuse('unsaved');

    renderLastPrompt().props.onDismiss();

    expect(watch.stop).toHaveBeenCalledTimes(1);
    expect(toastDismiss).toHaveBeenCalledWith(STALE_TAB_RELOAD_TOAST_ID);
  });

  test('the server returning to the loaded version withdraws a withheld reload', async () => {
    const { watch } = await refuse('unsaved');
    toastDismiss.mockClear();

    observeServerVersion(loadedFrom);

    expect(watch.stop).toHaveBeenCalledTimes(1);
    expect(toastDismiss).toHaveBeenCalledWith(STALE_TAB_RELOAD_TOAST_ID);
  });

  test('clicking Reload again stops watching the previous refusal', async () => {
    const { watch } = await refuse('unsaved');

    renderLastPrompt().props.onAction();

    expect(watch.stop).toHaveBeenCalledTimes(1);
  });

  test('a withheld reload does not bring the prompt back once the server is back in sync', async () => {
    let finishSaving: (result: SavedWorkResult) => void = () => {};
    const saving = new Promise<SavedWorkResult>((resolve) => {
      finishSaving = resolve;
    });
    const watch = refusalWatch();
    install({
      bridge: undefined,
      waitForSavedWork: () => saving,
      watchForSavedWork: watch.watchForSavedWork,
      reload: vi.fn(),
    });
    observeServerVersion(loadedFrom);
    observeServerVersion(upgraded);
    renderLastPrompt().props.onAction();
    await flush();

    observeServerVersion(loadedFrom);
    finishSaving('unsaved');
    await flush();

    expect(toastCustom).toHaveBeenCalledTimes(1);
    expect(watch.started()).toBe(false);
  });

  test('Not now dismisses without reloading', () => {
    const reload = vi.fn();
    install({ bridge: undefined, waitForSavedWork: () => Promise.resolve('saved'), reload });
    observeServerVersion(loadedFrom);
    observeServerVersion(upgraded);

    renderLastPrompt().props.onDismiss();

    expect(toastDismiss).toHaveBeenCalledWith(STALE_TAB_RELOAD_TOAST_ID);
    expect(reload).not.toHaveBeenCalled();
  });

  test('the prompt is withdrawn when the server returns to the loaded version', () => {
    install({
      bridge: undefined,
      waitForSavedWork: () => Promise.resolve('saved'),
      reload: vi.fn(),
    });
    observeServerVersion(loadedFrom);
    observeServerVersion(upgraded);
    toastDismiss.mockClear();

    observeServerVersion(loadedFrom);

    expect(toastDismiss).toHaveBeenCalledWith(STALE_TAB_RELOAD_TOAST_ID);
  });

  test('teardown stops prompting and stops watching a withheld reload', async () => {
    const { watch } = await refuse('unsaved');
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    toastCustom.mockClear();

    observeServerVersion({ runtimeVersion: '0.83.3', protocolVersion: 2 });

    expect(watch.stop).toHaveBeenCalledTimes(1);
    expect(toastCustom).not.toHaveBeenCalled();
  });
});

describe('stale tab reload copy', () => {
  test('names a build change when the server no longer reports its version', () => {
    const body = staleTabReloadBody({
      loaded: loadedFrom,
      current: { runtimeVersion: null, protocolVersion: null },
    });
    expect(body).toBe(
      'OpenKnowledge on this computer changed to a different build, but this tab is still running the old one.',
    );
  });

  test('each refusal reason has its own sentence', () => {
    expect(staleTabReloadRefusal('unsaved', [])).toBe(UNSAVED_REFUSAL);
    expect(staleTabReloadRefusal('reconnecting', ['notes'])).toBe(RECONNECTING_REFUSAL);
    expect(staleTabReloadRefusal('unconfirmed', ['notes'])).toBe(UNCONFIRMED_REFUSAL);
  });

  test('names the documents to open, quoted', () => {
    expect(staleTabReloadRefusal('unsaved', ['notes', 'plans/q4'])).toBe(
      'Some edits haven\'t reached the server yet, so the tab didn\'t reload. Open "notes" and "plans/q4" to save them, then reload.',
    );
  });

  test('caps a long list of documents to open', () => {
    expect(staleTabReloadRefusal('unsaved', ['a', 'b', 'c', 'd', 'e'])).toBe(
      'Some edits haven\'t reached the server yet, so the tab didn\'t reload. Open "a", "b", and 3 others to save them, then reload.',
    );
  });
});

describe('waitForSavedWork', () => {
  test('resolves saved at once when nothing is pending', async () => {
    const { source } = workSource({ unsynced: false });

    await expect(waitForSavedWork(source, 1000)).resolves.toBe('saved');
  });

  test('waits for pending edits to be acknowledged', async () => {
    const work = workSource({ unsynced: true });

    const result = waitForSavedWork(work.source, 1000);
    await flush();
    expect(work.listenerCount()).toBe(1);
    work.finishSync();

    await expect(result).resolves.toBe('saved');
    expect(work.listenerCount()).toBe(0);
  });

  test('waits for an edit buffered across the restart to replay', async () => {
    const work = workSource({ unsynced: false, pendingReplay: true });
    let done = false;

    const result = waitForSavedWork(work.source, 1000).then((saved) => {
      done = true;
      return saved;
    });
    await flush();
    expect(done).toBe(false);
    work.finishReplay();

    await expect(result).resolves.toBe('saved');
  });

  test('reports reconnecting when another server-restart recovery has started', async () => {
    const work = workSource({ unsynced: false, recycleInFlightAfterSettle: true });

    await expect(waitForSavedWork(work.source, 1000)).resolves.toBe('reconnecting');
  });

  test('reports reconnecting when recovery outlasts the deadline', async () => {
    vi.useFakeTimers();
    try {
      const work = workSource({ unsynced: false, settled: new Promise<void>(() => {}) });

      const result = waitForSavedWork(work.source, 1000);
      await vi.advanceTimersByTimeAsync(1001);

      await expect(result).resolves.toBe('reconnecting');
    } finally {
      vi.useRealTimers();
    }
  });

  test('waits for a server-restart recovery to finish first', async () => {
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const work = workSource({ unsynced: false, settled });
    let done = false;

    const result = waitForSavedWork(work.source, 1000).then((saved) => {
      done = true;
      return saved;
    });
    await flush();
    expect(done).toBe(false);
    settle();

    await expect(result).resolves.toBe('saved');
  });

  test('gives up when edits stay pending past the deadline', async () => {
    vi.useFakeTimers();
    try {
      const work = workSource({ unsynced: true });

      const result = waitForSavedWork(work.source, 1000);
      await vi.advanceTimersByTimeAsync(1001);

      await expect(result).resolves.toBe('unsaved');
      expect(work.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('watchForSavedWork', () => {
  test('reports once recovery has settled and nothing is unsaved', async () => {
    const work = workSource({ unsynced: false });
    const onSaved = vi.fn();

    watchForSavedWork(work.source, onSaved);
    await flush();

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(work.listenerCount()).toBe(0);
  });

  test('waits for edits to be acknowledged, then reports once', async () => {
    const work = workSource({ unsynced: true });
    const onSaved = vi.fn();

    watchForSavedWork(work.source, onSaved);
    await flush();
    expect(onSaved).not.toHaveBeenCalled();
    work.finishSync();
    work.finishSync();

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(work.listenerCount()).toBe(0);
  });

  test('waits while another server-restart recovery is running', async () => {
    const work = workSource({ unsynced: false, recycleInFlightAfterSettle: true });
    const onSaved = vi.fn();

    watchForSavedWork(work.source, onSaved);
    await flush();
    expect(onSaved).not.toHaveBeenCalled();
    work.finishRecycle();

    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test('stopping it before recovery settles means it never reports', async () => {
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const work = workSource({ unsynced: false, settled });
    const onSaved = vi.fn();

    const stop = watchForSavedWork(work.source, onSaved);
    stop();
    settle();
    await flush();

    expect(onSaved).not.toHaveBeenCalled();
    expect(work.listenerCount()).toBe(0);
  });
});
