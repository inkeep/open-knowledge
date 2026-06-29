import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isMacOS } from '@tiptap/core';
import type { ReactNode } from 'react';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
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

mock.module('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => ({
    hasRemote,
    pushPermission: { checkStatus: 'allowed' },
  }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectConfig,
    projectLocalConfig,
    projectLocalSynced,
    projectSynced,
  }),
}));

mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeDocName: 'docs/notes', collabUrl: 'ws://test' }),
}));

mock.module('@/editor/use-editor-mode', () => ({
  useEditorMode: () => ['wysiwyg', () => {}],
}));

mock.module('./EditorHeader', () => ({
  EditorHeader: () => <div data-testid="editor-header" />,
}));

mock.module('./EditorArea', () => ({
  EditorArea: ({
    terminalBridge,
    terminalVisible,
    terminalLaunch,
  }: {
    terminalBridge?: unknown;
    terminalVisible?: boolean;
    terminalLaunch?: { nonce: number } | null;
  }) => (
    <div data-testid="editor-area">
      {terminalBridge != null ? (
        <div
          data-testid="terminal-dock"
          data-visible={String(terminalVisible)}
          data-launch-nonce={terminalLaunch ? String(terminalLaunch.nonce) : 'none'}
        />
      ) : null}
    </div>
  ),
}));

const terminalOpenedCalls: true[] = [];
mock.module('@/lib/terminal-telemetry', () => ({
  recordTerminalOpened: () => terminalOpenedCalls.push(true),
  recordShellConsentGranted: () => undefined,
}));

mock.module('./AuthModal', () => ({
  AuthModal: () => <div data-testid="auth-modal" />,
}));

mock.module('@/editor/components/TagDialog', () => ({
  TagDialog: () => <div data-testid="tag-dialog" />,
}));

mock.module('./AutoSyncOnboardingDialog', () => ({
  AutoSyncOnboardingDialog: ({ open, onResolved }: { open: boolean; onResolved: () => void }) => (
    <button
      type="button"
      data-testid="auto-sync-onboarding"
      data-open={String(open)}
      onClick={onResolved}
    >
      Auto sync onboarding
    </button>
  ),
}));

async function renderEditorPane() {
  const { EditorPane } = await import('./EditorPane');
  render(<EditorPane />);
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

  test.each([
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
      'enabled undefined is not the unanswered sentinel',
      true,
      true,
      true,
      { autoSync: {} },
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
      },
    },
  };
}

describe('EditorPane terminal dock wiring', () => {
  afterEach(() => {
    cleanup();
    delete (window as { okDesktop?: unknown }).okDesktop;
    terminalOpenedCalls.length = 0;
  });

  test('web host renders the editor chrome without a terminal dock', async () => {
    await renderEditorPane();

    expect(screen.queryByTestId('terminal-dock')).toBeNull();
    expect(screen.getByTestId('editor-header')).toBeTruthy();
    expect(screen.getByTestId('editor-area')).toBeTruthy();
  });

  test('desktop host renders the editor chrome with the terminal dock under the editor area', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();

    expect(screen.getByTestId('editor-header')).toBeTruthy();
    const area = screen.getByTestId('editor-area');
    expect(area.querySelector('[data-testid="terminal-dock"]')).not.toBeNull();
  });

  test('desktop: toggle-terminal menu action flips dock visibility and pushes the view-menu state', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
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

    act(() => requestTerminalLaunch('work on docs/notes', 'claude'));
    expect(dock().getAttribute('data-visible')).toBe('true');
    expect(dock().getAttribute('data-launch-nonce')).toBe('1');

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-visible')).toBe('false');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

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

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

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

    expect(terminalOpenedCalls).toHaveLength(0);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // hidden → open
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // open → hidden (no record)
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // hidden → open again
    expect(terminalOpenedCalls).toHaveLength(2);
  });

  test('desktop: a reload re-expands a dock that was open before it (retained visibility is not clobbered)', async () => {
    let retainedDockVisible = true;
    (window as { okDesktop?: unknown }).okDesktop = {
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

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(terminalOpenedCalls).toHaveLength(0);
  });

  test('desktop: a rejecting getDockState still settles the gate so the view-menu push converges', async () => {
    const desk = makeOkDesktopStub(async () => {
      throw new Error('ipc boom');
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: false });
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
});
