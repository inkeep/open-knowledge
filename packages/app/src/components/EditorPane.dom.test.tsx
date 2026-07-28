import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isMacOS } from '@tiptap/core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { publishSelectionContext } from '@/editor/selection-context';
import type { EditorSurface } from '@/editor/selection-stats';
import { subscribeToPreferredSessionRequests } from './handoff/preferred-session-events';
import { subscribeToActiveTerminalInput } from './handoff/terminal-input-events';

// The doc the mocked DocumentContext reports (see the useDocumentContext mock).
const TEST_DOC = 'docs/notes';

// Seed / clear the shared selection snapshot registry EditorPane reads for the
// ⌘J / ⇧⌘J selection-paste path. Seed both body surfaces so the test is
// independent of the default editor mode.
function seedSelection(markdown: string): void {
  for (const surface of ['wysiwyg', 'source'] as EditorSurface[]) {
    publishSelectionContext(TEST_DOC, surface, {
      surface,
      docName: TEST_DOC,
      markdown,
      charLen: markdown.length,
      lineCount: 1,
    });
  }
}
function clearSelection(): void {
  publishSelectionContext(TEST_DOC, 'wysiwyg', null);
  publishSelectionContext(TEST_DOC, 'source', null);
}

// Collect the Ask-AI passages EditorPane dispatches to the sessions host (which
// owns reuse-vs-launch and preferred-AI resolution; mocked here). `newTab` rides
// along so ⌘J (reuse when sensible) stays distinguishable from ⇧⌘J (always fresh).
function captureActiveTerminalInput(): {
  texts: string[];
  details: { text: string; newTab: boolean; submit: boolean }[];
  stop: () => void;
} {
  const texts: string[] = [];
  const details: { text: string; newTab: boolean; submit: boolean }[] = [];
  const stop = subscribeToActiveTerminalInput((detail) => {
    texts.push(detail.text);
    details.push({ text: detail.text, newTab: detail.newTab, submit: detail.submit });
  });
  return { texts, details, stop };
}

// Count the promptless "open my preferred AI" requests EditorPane dispatches
// (⇧⌘J with no selection). The host resolves which AI that is.
function capturePreferredSessionRequests(): { readonly count: number; stop: () => void } {
  const state = { count: 0, stop: () => {} };
  const unsubscribe = subscribeToPreferredSessionRequests(() => {
    state.count += 1;
  });
  state.stop = unsubscribe;
  return state;
}

function shiftJKeydownInit(): KeyboardEventInit {
  const init: KeyboardEventInit = { key: 'j', shiftKey: true, cancelable: true, bubbles: true };
  if (isMacOS()) init.metaKey = true;
  else init.ctrlKey = true;
  return init;
}

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

let hasRemote = false;
let projectLocalSynced = false;
let projectSynced = false;
let projectLocalConfig: { autoSync?: { enabled?: boolean | null } } | null = null;
let projectConfig: { autoSync?: { default?: boolean | null } } | null = null;
let pushPermissionCheckStatus: 'allowed' | 'denied' | 'unknown' | undefined = 'allowed';

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => ({
    hasRemote,
    pushPermission: { checkStatus: pushPermissionCheckStatus },
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectConfig,
    projectLocalConfig,
    projectLocalSynced,
    projectSynced,
  }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeDocName: 'docs/notes', collabUrl: 'ws://test' }),
}));

vi.doMock('@/editor/use-editor-mode', () => ({
  useEditorMode: () => ['wysiwyg', () => {}],
}));

vi.doMock('./EditorHeader', () => ({
  EditorHeader: () => <div data-testid="editor-header" />,
}));

// EditorArea renders the bottom layout shell + reports the terminal placement up;
// the live session host now lives in EditorPane as a sibling of EditorArea (so a
// dock toggle can't remount it). EditorPane still owns the open/⌘J/menu/telemetry
// state. The EditorArea mock is a bare stand-in; the TerminalSessionsHost mock
// (below) surfaces the threaded `visible` + `launch` props so these tests keep
// asserting EditorPane's wiring across the prop boundary.
vi.doMock('./EditorArea', () => ({
  EditorArea: () => <div data-testid="editor-area" />,
}));
// The agent-thread client binder opens a WS + polls /api/config on mount; stub it
// so these EditorPane tests exercise terminal/onboarding wiring in isolation.
vi.doMock('./acp/AgentThreadClientBinder', () => ({
  AgentThreadClientBinder: () => null,
}));
// The sessions host now mounts UNCONDITIONALLY (web too) — a shell and an agent
// are just tabs of a different kind. It receives `bridge` (null on web) so these
// tests assert EditorPane's wiring across the prop boundary, including which host
// gets a live bridge.
vi.doMock('./TerminalSessionsHost', () => ({
  TerminalSessionsHost: ({
    bridge,
    visible,
    launch,
  }: {
    bridge?: unknown;
    visible?: boolean;
    launch?: { nonce: number; stagePaste?: string } | null;
  }) => {
    return (
      <div
        data-testid="terminal-dock"
        data-has-bridge={String(bridge != null)}
        data-visible={String(visible)}
        data-launch-nonce={launch ? String(launch.nonce) : 'none'}
        data-launch-stage={launch?.stagePaste ?? 'none'}
      />
    );
  },
}));

const terminalOpenedCalls: true[] = [];
vi.doMock('@/lib/terminal-telemetry', () => ({
  recordTerminalOpened: () => terminalOpenedCalls.push(true),
  recordShellConsentGranted: () => undefined,
}));

vi.doMock('./AuthModal', () => ({
  AuthModal: () => <div data-testid="auth-modal" />,
}));

vi.doMock('@/editor/components/TagDialog', () => ({
  TagDialog: () => <div data-testid="tag-dialog" />,
}));

vi.doMock('./AutoSyncOnboardingDialog', () => ({
  AutoSyncOnboardingDialog: ({
    open,
    variant,
    onResolved,
  }: {
    open: boolean;
    variant: string;
    onResolved: () => void;
  }) => (
    <button
      type="button"
      data-testid="auto-sync-onboarding"
      data-open={String(open)}
      data-variant={variant}
      onClick={onResolved}
    >
      Auto sync onboarding
    </button>
  ),
}));

async function renderEditorPane() {
  const { EditorPane } = await import('./EditorPane');
  render(<EditorPane />);
  // Flush the mount-time async dock-state restore (getDockState) and the
  // re-render it triggers, so the now-gated View-menu push settles
  // deterministically before assertions read viewMenuPushes / data-visible.
  await act(async () => {});
}

describe('EditorPane auto-sync onboarding gate', () => {
  afterEach(() => {
    cleanup();
    hasRemote = false;
    projectLocalSynced = false;
    projectSynced = false;
    projectLocalConfig = null;
    projectConfig = null;
    pushPermissionCheckStatus = 'allowed';
  });

  test('exports the EditorPane component', async () => {
    const mod = await import('./EditorPane');
    expect(typeof mod.EditorPane).toBe('function');
  });

  test('opens when remote exists, both configs synced, enabled is null, and no committed default', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('true');
  });

  test('opens when autoSync carries neither a mode nor a legacy enabled value', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    // Neither key set → the resolved local mode is null (unanswered), so the
    // prompt fires — the mode resolver treats absent the same as the null
    // sentinel, unlike the old literal `enabled === null` check.
    projectLocalConfig = { autoSync: {} };
    projectConfig = { autoSync: { default: null } };

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('true');
  });

  test.each([
    // label, hasRemote, projectSynced, projectLocalSynced, projectLocalConfig, projectConfig
    [
      'no remote',
      false,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    [
      'committed config not synced',
      true,
      false,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    [
      'project-local config not synced',
      true,
      true,
      false,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    ['project-local config missing', true, true, true, null, { autoSync: { default: null } }],
    [
      'enabled true already answered',
      true,
      true,
      true,
      { autoSync: { enabled: true } },
      { autoSync: { default: null } },
    ],
    [
      'enabled false already answered',
      true,
      true,
      true,
      { autoSync: { enabled: false } },
      { autoSync: { default: null } },
    ],
    [
      'committed default off suppresses the prompt',
      true,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: false } },
    ],
    [
      'committed default on suppresses the prompt',
      true,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: true } },
    ],
  ] as const)('stays closed when %s', async (_label, nextHasRemote, nextProjectSynced, nextSynced, nextProjectLocalConfig, nextProjectConfig) => {
    hasRemote = nextHasRemote;
    projectSynced = nextProjectSynced;
    projectLocalSynced = nextSynced;
    projectLocalConfig = nextProjectLocalConfig;
    projectConfig = nextProjectConfig;

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
  });

  test('a denied push probe opens the pull-only variant', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    pushPermissionCheckStatus = 'denied';

    await renderEditorPane();

    const dialog = screen.getByTestId('auto-sync-onboarding');
    expect(dialog.getAttribute('data-open')).toBe('true');
    expect(dialog.getAttribute('data-variant')).toBe('follow');
  });

  test('an unknown push probe keeps the prompt closed', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    pushPermissionCheckStatus = 'unknown';

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
  });

  test('resolved onboarding dismisses the dialog in the same render path', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    await renderEditorPane();

    const dialog = screen.getByTestId('auto-sync-onboarding');
    expect(dialog.getAttribute('data-open')).toBe('true');

    await userEvent.click(dialog);

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
  });
});

// Minimal faithful stand-in for the desktop bridge surfaces EditorPane's
// terminal wiring touches: `onMenuAction` (subscribe), the View-menu-state push,
// `terminal.getDockState` (read once on mount to restore dock visibility after a
// reload), and `terminal.cliInstalledMap` (read once on mount for the New-chat
// default CLI). The real `window.okDesktop` always exposes these, so an empty
// `{}` stub would no longer model the boundary now that EditorPane calls them on
// mount. getDockState resolves `visible: false` so the restore is a no-op —
// these tests exercise the start-hidden toggle/launch behavior.
function makeOkDesktopStub(
  getDockState: () => Promise<{ visible: boolean }> = async () => ({ visible: false }),
) {
  const menuHandlers: Array<(action: string) => void> = [];
  const viewMenuPushes: Array<{ terminalVisible?: boolean }> = [];
  return {
    viewMenuPushes,
    dispatchMenuAction(action: string) {
      for (const cb of menuHandlers) cb(action);
    },
    stub: {
      // The terminal affordances gate on the host's pty capability
      // (`config.ptyAvailable`, false on win/linux where node-pty isn't
      // bundled) — these tests model the capable macOS host.
      config: { ptyAvailable: true },
      onMenuAction(cb: (action: string) => void) {
        menuHandlers.push(cb);
        return () => {
          const index = menuHandlers.indexOf(cb);
          if (index >= 0) menuHandlers.splice(index, 1);
        };
      },
      editor: {
        notifyViewMenuStateChanged(state: { terminalVisible?: boolean }) {
          viewMenuPushes.push(state);
        },
      },
      terminal: {
        getDockState,
        cliInstalledMap: async () => ({
          claude: true,
          codex: false,
          opencode: false,
          cursor: false,
        }),
      },
    },
  };
}

describe('EditorPane terminal dock wiring', () => {
  afterEach(() => {
    cleanup();
    delete (window as { okDesktop?: unknown }).okDesktop;
    terminalOpenedCalls.length = 0;
    clearSelection();
  });

  test('web host mounts the sessions host (host-agnostic) with no desktop bridge', async () => {
    await renderEditorPane();

    // The unified sessions dock is host-agnostic now — it mounts on web too (thread
    // tabs only), just without a desktop bridge (terminal-kind affordances gate on
    // the bridge inside the host).
    const dock = screen.getByTestId('terminal-dock');
    expect(dock).toBeTruthy();
    expect(dock.getAttribute('data-has-bridge')).toBe('false');
    expect(screen.getByTestId('editor-header')).toBeTruthy();
    expect(screen.getByTestId('editor-area')).toBeTruthy();
  });

  test('desktop host mounts the sessions host with a live bridge under the editor area', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();

    // The header and the live session host are both siblings of the editor area
    // (the host lives in EditorPane so a dock toggle can't remount it). On desktop
    // the host gets a live bridge.
    expect(screen.getByTestId('editor-header')).toBeTruthy();
    expect(screen.getByTestId('editor-area')).toBeTruthy();
    const dock = screen.getByTestId('terminal-dock');
    expect(dock).not.toBeNull();
    expect(dock.getAttribute('data-has-bridge')).toBe('true');
  });

  test('desktop: toggle-terminal menu action flips dock visibility and pushes the view-menu state', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    // Mount pushes terminalVisible:false so the View menu reads "Show Terminal".
    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: false });

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: true });

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: false });
  });

  test('desktop: hiding the terminal clears the launch intent so a reopen is blank (regression)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const { requestTerminalLaunch } = await import('./handoff/terminal-launch-events');
    await renderEditorPane();

    const dock = () => screen.getByTestId('terminal-dock');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

    // "Open in terminal" opens the dock and carries a one-shot launch intent.
    act(() => requestTerminalLaunch('work on docs/notes', 'claude'));
    expect(dock().getAttribute('data-visible')).toBe('true');
    expect(dock().getAttribute('data-launch-nonce')).toBe('1');

    // Hiding clears the spent intent. A kill drops the dock's mount latch and
    // destroys the session's once-per-nonce guard; both kill and the ⌘J toggle
    // hide via onVisibleChange(false). Without clearing here, the next fresh
    // mount would replay the old prompt instead of opening blank.
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-visible')).toBe('false');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

    // Reopening (New Terminal) is blank — no stale launch intent re-applied.
    act(() => desk.dispatchMenuAction('new-terminal'));
    expect(dock().getAttribute('data-visible')).toBe('true');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');
  });

  test('desktop: a distinct Open-in-terminal after a hide gets a fresh, monotonic nonce', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const { requestTerminalLaunch } = await import('./handoff/terminal-launch-events');
    await renderEditorPane();

    const dock = () => screen.getByTestId('terminal-dock');

    act(() => requestTerminalLaunch('first', 'claude'));
    expect(dock().getAttribute('data-launch-nonce')).toBe('1');

    // Hide clears the spent intent.
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

    // The second, distinct click must NOT reuse nonce 1. The nonce is drawn
    // from a monotonic source rather than the previous intent's value — if it
    // restarted at 1 after the hide-clear, the dock's per-nonce dedup would see
    // a repeat of the already-opened tab and drop it, opening no new tab.
    act(() => requestTerminalLaunch('second', 'codex'));
    expect(dock().getAttribute('data-launch-nonce')).toBe('2');
  });

  test('desktop: new-terminal menu action opens the dock and stays open on repeat (not a toggle)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');

    act(() => desk.dispatchMenuAction('new-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');

    // Idempotent open: a second New Terminal keeps it open. The View toggle
    // would have hidden it here — that is the behavioral split between them.
    act(() => desk.dispatchMenuAction('new-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
  });

  test('desktop: an unrelated menu action does not toggle the terminal', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => desk.dispatchMenuAction('toggle-doc-panel'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
  });

  test('desktop: each open records terminal-opened; mount (hidden) and close do not', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    // Starts hidden — the mount run of the effect must not record an open.
    expect(terminalOpenedCalls).toHaveLength(0);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // hidden → open
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // open → hidden (no record)
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // hidden → open again
    expect(terminalOpenedCalls).toHaveLength(2);
  });

  test('desktop: a reload re-expands a dock that was open before it (retained visibility is not clobbered)', async () => {
    // Model main's per-window dock-visibility map at the boundary the hardcoded
    // `visible: false` stub can't: the renderer's view-menu push WRITES it,
    // getDockState READS it back. It starts `true` — the dock was open before
    // this reload. The bug is an ordering race between the two channels: the
    // mount-initial `false` push must not land in the shared map before the
    // restore reads it, or the read returns false and the dock comes back
    // collapsed (the whole feature dead).
    let retainedDockVisible = true;
    (window as { okDesktop?: unknown }).okDesktop = {
      config: { ptyAvailable: true },
      onMenuAction: () => () => {},
      editor: {
        notifyViewMenuStateChanged(state: { terminalVisible?: boolean }) {
          if (state.terminalVisible !== undefined) retainedDockVisible = state.terminalVisible;
        },
      },
      terminal: {
        getDockState: async () => ({ visible: retainedDockVisible }),
      },
    };

    await renderEditorPane();

    // Restored: the dock comes back expanded without a user re-open, and the
    // restore reveal is NOT counted as a user-initiated terminal open.
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(terminalOpenedCalls).toHaveLength(0);
  });

  test('desktop: a rejecting getDockState still settles the gate so the view-menu push converges', async () => {
    // getDockState rejects (IPC torn down mid-reload). The restore's `.finally`
    // must still settle dockRestoreSettled so the deferred mount push lands —
    // mirrors TerminalDock's "rejecting list() still settles" guard. A
    // regression that settled only on the success branch would gate the View
    // menu's terminal item forever.
    const desk = makeOkDesktopStub(async () => {
      throw new Error('ipc boom');
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: false });
    // With no restored state the dock stays hidden (the breadcrumb is logged).
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
  });

  test('web host: a Cmd/Ctrl+J keydown is intercepted (the toggle handler is wired)', async () => {
    await renderEditorPane();

    const init: KeyboardEventInit = { key: 'j', cancelable: true, bubbles: true };
    if (isMacOS()) init.metaKey = true;
    else init.ctrlKey = true;
    const event = new KeyboardEvent('keydown', init);
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  test('web host: an unrelated keydown is not intercepted', async () => {
    await renderEditorPane();

    const event = new KeyboardEvent('keydown', {
      key: 'g',
      metaKey: true,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  test('desktop: ⇧⌘J with no selection asks the host for a preferred-AI session', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    const input = captureActiveTerminalInput();
    const preferred = capturePreferredSessionRequests();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit()));
    });
    input.stop();
    preferred.stop();

    // The dock reveals and the host is asked to open the user's preferred AI.
    // EditorPane deliberately names no CLI: resolving here could only ever yield
    // a CLI, which is what made ⇧⌘J ignore a preferred ACP agent.
    const dock = screen.getByTestId('terminal-dock');
    expect(dock.getAttribute('data-visible')).toBe('true');
    expect(preferred.count).toBe(1);
    expect(dock.getAttribute('data-launch-nonce')).toBe('none');
    expect(input.texts).toEqual([]);
  });

  test('desktop: ⇧⌘J with a selection sends the passage to the host as a NEW session', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    seedSelection('some highlighted text');
    const input = captureActiveTerminalInput();
    const preferred = capturePreferredSessionRequests();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit()));
    });
    input.stop();
    preferred.stop();

    // The passage rides the Ask-AI channel with `newTab` set, so the host opens a
    // fresh session in whichever family the user prefers instead of reusing one.
    // Nothing is auto-run and no CLI is named here.
    const dock = screen.getByTestId('terminal-dock');
    expect(dock.getAttribute('data-visible')).toBe('true');
    expect(input.details).toHaveLength(1);
    expect(input.details[0]?.newTab).toBe(true);
    expect(input.details[0]?.text).toContain('some highlighted text');
    // Raw selected material, never an instruction: `submit` stays false so a
    // fresh session writes it and waits. A true here would auto-run a passage the
    // user only highlighted.
    expect(input.details[0]?.submit).toBe(false);
    // Trailing soft newlines land the caret on a blank line below the passage.
    expect(input.details[0]?.text.endsWith('\n\n')).toBe(true);
    // A selection send is not a promptless "new chat" request.
    expect(preferred.count).toBe(0);
    expect(dock.getAttribute('data-launch-nonce')).toBe('none');
  });

  test('desktop: ⇧⌘J claims the event (preventDefault)', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    const event = new KeyboardEvent('keydown', shiftJKeydownInit());
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  test('web host: ⇧⌘J is a no-op (no terminal to open)', async () => {
    await renderEditorPane();
    const event = new KeyboardEvent('keydown', shiftJKeydownInit());
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    // The sessions dock still mounts host-agnostic (thread tabs), but ⇧⌘J is a
    // terminal-launch accelerator: with no desktop bridge it stages nothing.
    expect(screen.getByTestId('terminal-dock').getAttribute('data-launch-nonce')).toBe('none');
  });

  test('desktop: ⌘J with a selection sends the passage to the host for reuse (no toggle, no launch)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    seedSelection('run the build');
    const input = captureActiveTerminalInput();

    // ⌘J arrives via the OS-captured menu accelerator → the toggle-terminal action.
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    input.stop();

    // ⌘J means "continue where I am when that makes sense", so `newTab` is unset
    // and the host decides: a running CLI or an open agent thread takes the
    // passage, otherwise it launches the preferred AI. EditorPane reveals the dock
    // and stages nothing itself — whether the active tab is a CLI, a bare shell, or
    // an agent thread is knowledge only the host has.
    const dock = screen.getByTestId('terminal-dock');
    expect(input.details).toHaveLength(1);
    expect(input.details[0]?.newTab).toBe(false);
    expect(input.details[0]?.text).toContain('run the build');
    expect(input.details[0]?.submit).toBe(false);
    // Trailing soft newlines land the caret on a blank line below the passage.
    expect(input.details[0]?.text.endsWith('\n\n')).toBe(true);
    expect(dock.getAttribute('data-launch-nonce')).toBe('none');
    expect(dock.getAttribute('data-visible')).toBe('true');
  });

  test('desktop: ⌘J with no selection still toggles and stages nothing', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    const input = captureActiveTerminalInput();

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    input.stop();

    const dock = screen.getByTestId('terminal-dock');
    expect(dock.getAttribute('data-visible')).toBe('true');
    expect(dock.getAttribute('data-launch-nonce')).toBe('none');
    expect(input.texts).toEqual([]);
  });
});
