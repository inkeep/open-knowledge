/**
 * Menu actions must survive the gap between window-open and first render.
 *
 * The menu lives in main and is live the instant the window exists. The
 * renderer's listener is not: `local-menu-action-bus` installs its single
 * `onMenuAction` forwarder lazily, on first subscribe, which happens inside a
 * React effect — so only after the first commit. Between those two moments
 * main will happily push `ok:menu-action` at a renderer that has never called
 * `ipcRenderer.on`, and an Electron IPC event with no listener is not delayed
 * or retried, it is gone. The user-visible shape is CmdOrCtrl+J during launch
 * doing nothing at all.
 *
 * It stays invisible in the desktop smoke suite because `revealTerminalSurface`
 * re-clicks the menu item until the panel appears, which turns a dropped action
 * into a merely slow one. It surfaced instead in the one smoke test that cannot
 * retry — the toggle-latency test in `terminal-dock.e2e.ts` — as a bare 5s
 * `waitForSelector` timeout against an app that was otherwise healthy.
 *
 * These tests drive the preload's real `ok:menu-action` handler directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type IpcListener = (event: unknown, ...args: unknown[]) => void;

const exposed = new Map<string, Record<string, unknown>>();
const channelListeners = new Map<string, Set<IpcListener>>();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: Record<string, unknown>) => {
      exposed.set(key, value);
    },
  },
  ipcRenderer: {
    invoke: () => Promise.resolve({ ok: true }),
    on: (channel: string, listener: IpcListener) => {
      const set = channelListeners.get(channel) ?? new Set<IpcListener>();
      set.add(listener);
      channelListeners.set(channel, set);
    },
    removeListener: (channel: string, listener: IpcListener) => {
      channelListeners.get(channel)?.delete(listener);
    },
    send: () => {},
  },
  webUtils: { getPathForFile: () => '' },
}));

type MenuOrigin = { launcherBorne: boolean };

type MenuBridge = {
  onMenuAction(cb: (action: string, origin: MenuOrigin) => void): () => void;
};

async function loadBridge(): Promise<MenuBridge> {
  exposed.clear();
  channelListeners.clear();
  vi.resetModules();
  await import('./index.ts');
  const bridge = exposed.get('okDesktop');
  if (bridge === undefined) throw new Error('preload did not expose okDesktop');
  return bridge as unknown as MenuBridge;
}

/**
 * Push one `ok:menu-action` exactly as main does — a whole dispatch envelope,
 * not a bare action. Defaults to the launcher-free origin main stamps for a
 * native menu item or a keyboard accelerator.
 */
function pushMenuAction(action: string, origin: MenuOrigin = { launcherBorne: false }): void {
  const listeners = channelListeners.get('ok:menu-action');
  if (listeners === undefined || listeners.size === 0) {
    throw new Error(
      'the preload registered no ok:menu-action listener at load — a menu action arriving before the renderer subscribes would be dropped',
    );
  }
  for (const listener of listeners) listener({}, { action, origin });
}

/** Let the replay microtask run. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

beforeEach(() => {
  exposed.clear();
  channelListeners.clear();
});

describe('preload menu-action delivery', () => {
  it('subscribes to the channel at load, before any renderer code runs', async () => {
    await loadBridge();

    // The whole fix: the listener exists without anyone having called
    // `onMenuAction`. Registering it lazily is what loses the early action.
    expect(channelListeners.get('ok:menu-action')?.size ?? 0).toBeGreaterThan(0);
  });

  it('replays an action that arrived before the renderer subscribed', async () => {
    const bridge = await loadBridge();
    pushMenuAction('toggle-terminal');

    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));
    // Pinned, not incidental: the drain is deferred a turn so it cannot re-enter
    // the React effect that is still running `subscribeLocalMenuAction`. Without
    // this line a synchronous drain would pass every other assertion here.
    expect(seen).toEqual([]);
    await settle();

    expect(seen).toEqual(['toggle-terminal']);
  });

  it('replays several early actions in the order they arrived', async () => {
    const bridge = await loadBridge();
    pushMenuAction('toggle-sidebar');
    pushMenuAction('toggle-terminal');
    pushMenuAction('new-terminal');

    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));
    await settle();

    expect(seen).toEqual(['toggle-sidebar', 'toggle-terminal', 'new-terminal']);
  });

  it('delivers live actions straight through once a subscriber is attached', async () => {
    const bridge = await loadBridge();
    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));

    pushMenuAction('toggle-terminal');

    // No queue hop for the ordinary path — a menu click must land in the same
    // turn it arrives, exactly as it did before any buffering existed.
    expect(seen).toEqual(['toggle-terminal']);
  });

  it('fans a live action out to every subscriber', async () => {
    const bridge = await loadBridge();
    const first: string[] = [];
    const second: string[] = [];
    bridge.onMenuAction((action) => first.push(action));
    bridge.onMenuAction((action) => second.push(action));

    pushMenuAction('toggle-doc-panel');

    expect(first).toEqual(['toggle-doc-panel']);
    expect(second).toEqual(['toggle-doc-panel']);
  });

  it('does not replay the backlog to a second subscriber', async () => {
    const bridge = await loadBridge();
    pushMenuAction('toggle-terminal');

    const first: string[] = [];
    bridge.onMenuAction((action) => first.push(action));
    await settle();

    const second: string[] = [];
    bridge.onMenuAction((action) => second.push(action));
    await settle();

    // The intent was already honored. Handing it to the next component to
    // mount would toggle the terminal back off.
    expect(first).toEqual(['toggle-terminal']);
    expect(second).toEqual([]);
  });

  it('stops delivering to an unsubscribed callback', async () => {
    const bridge = await loadBridge();
    const seen: string[] = [];
    const unsubscribe = bridge.onMenuAction((action) => seen.push(action));

    unsubscribe();
    pushMenuAction('toggle-terminal');
    await settle();

    expect(seen).toEqual([]);
  });

  it('never queues an action that destroys something', async () => {
    const bridge = await loadBridge();
    // What these act on is resolved when they RUN, so a late replay aims at
    // whatever is selected by then rather than at what the user was looking at.
    pushMenuAction('kill-terminal');
    pushMenuAction('close-active-tab-or-window');
    pushMenuAction('delete');
    pushMenuAction('move-to-trash');

    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));
    await settle();

    expect(seen).toEqual([]);
  });

  it('still delivers a destructive action live', async () => {
    const bridge = await loadBridge();
    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));

    pushMenuAction('kill-terminal');

    // Only the QUEUE refuses them; a live press must still work.
    expect(seen).toEqual(['kill-terminal']);
  });

  it('collapses a repeated parity toggle into the one intent it expresses', async () => {
    const bridge = await loadBridge();
    // Pressing CmdOrCtrl+J three times because nothing happened means "open",
    // not "open, close, open". Replaying all three would leave it shut.
    pushMenuAction('toggle-terminal');
    pushMenuAction('toggle-terminal');
    pushMenuAction('toggle-terminal');

    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));
    await settle();

    expect(seen).toEqual(['toggle-terminal']);
  });

  it('keeps a parity toggle that is interleaved with another', async () => {
    const bridge = await loadBridge();
    pushMenuAction('toggle-terminal');
    pushMenuAction('toggle-sidebar');
    pushMenuAction('toggle-terminal');

    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));
    await settle();

    // Three distinct intents: only an immediately repeated press is a restatement.
    expect(seen).toEqual(['toggle-terminal', 'toggle-sidebar', 'toggle-terminal']);
  });

  it('keeps every repeat of an additive action', async () => {
    const bridge = await loadBridge();
    pushMenuAction('new-terminal');
    pushMenuAction('new-terminal');

    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));
    await settle();

    // Two presses of "new terminal" mean two terminals.
    expect(seen).toEqual(['new-terminal', 'new-terminal']);
  });

  it('keeps the backlog when the only subscriber leaves before the replay lands', async () => {
    const bridge = await loadBridge();
    pushMenuAction('toggle-terminal');

    // Attach and detach inside one turn: the replay microtask finds no listener.
    bridge.onMenuAction(() => {})();
    await settle();

    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));
    await settle();

    // Queued or delivered, never lost.
    expect(seen).toEqual(['toggle-terminal']);
  });

  it('bounds the backlog, keeping the newest intents', async () => {
    const bridge = await loadBridge();
    // A window type that never subscribes can still be main's chosen target,
    // so the queue must not grow without limit.
    for (let index = 0; index < 40; index += 1) pushMenuAction(`action-${index}`);

    const seen: string[] = [];
    bridge.onMenuAction((action) => seen.push(action));
    await settle();

    expect(seen).toHaveLength(32);
    expect(seen.at(0)).toBe('action-8');
    expect(seen.at(-1)).toBe('action-39');
  });
});

/**
 * The dispatching surface travels with the action, and the buffer is the place
 * it is easiest to lose: replaying a queued action without its origin would
 * hand the renderer a launcher-borne dispatch dressed as a native one.
 */
describe('preload menu-action origin', () => {
  it('hands a live subscriber the origin main stamped', async () => {
    const bridge = await loadBridge();
    const seen: Array<[string, MenuOrigin]> = [];
    bridge.onMenuAction((action, origin) => seen.push([action, origin]));

    pushMenuAction('report-bug', { launcherBorne: true });

    expect(seen).toEqual([['report-bug', { launcherBorne: true }]]);
  });

  it('replays a buffered action with the origin it was dispatched with', async () => {
    const bridge = await loadBridge();
    pushMenuAction('report-bug', { launcherBorne: true });

    const seen: Array<[string, MenuOrigin]> = [];
    bridge.onMenuAction((action, origin) => seen.push([action, origin]));
    await settle();

    expect(seen).toEqual([['report-bug', { launcherBorne: true }]]);
  });

  it('keeps distinct origins apart across a replayed batch', async () => {
    const bridge = await loadBridge();
    pushMenuAction('report-bug', { launcherBorne: true });
    pushMenuAction('report-bug', { launcherBorne: false });

    const seen: MenuOrigin[] = [];
    bridge.onMenuAction((_action, origin) => seen.push(origin));
    await settle();

    // `report-bug` is additive, so both survive — and neither inherits the
    // other's origin.
    expect(seen).toEqual([{ launcherBorne: true }, { launcherBorne: false }]);
  });

  it('collapses a repeated parity action on the action alone, keeping the queued origin', async () => {
    const bridge = await loadBridge();
    pushMenuAction('toggle-terminal', { launcherBorne: false });
    pushMenuAction('toggle-terminal', { launcherBorne: true });

    const seen: Array<[string, MenuOrigin]> = [];
    bridge.onMenuAction((action, origin) => seen.push([action, origin]));
    await settle();

    // A repeat with nothing on screen is the same intent restated, so the
    // queued dispatch stands whole — origin included.
    expect(seen).toEqual([['toggle-terminal', { launcherBorne: false }]]);
  });
});
