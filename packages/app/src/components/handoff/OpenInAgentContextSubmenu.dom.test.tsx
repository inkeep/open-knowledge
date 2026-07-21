import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import {
  desktopEnabledKey,
  reloadEnabledAgentsFromStorage,
  setAgentEnabled,
} from '@/lib/acp/enabled-agents';
import { registerAgent, reloadRegisteredAgentsFromStorage } from '@/lib/acp/registered-agents';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { TerminalLaunchProvider } from './TerminalLaunchContext';
import type { HandoffDispatchInput } from './useHandoffDispatch';

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  // A transitively-imported module uses the `msg` macro; the whole-module mock
  // must expose it too or the file fails to link.
  msg: renderLinguiTemplate,
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: { appearance: { preview: { autoOpen: true } } },
  }),
}));

vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({
    merged: { appearance: { preview: { autoOpen: true } } },
  }),
}));

vi.doMock('sonner', () => ({
  toast: {
    error: vi.fn(() => {}),
    success: vi.fn(() => {}),
  },
}));

const threadLaunchCalls: HandoffDispatchInput[] = [];
const threadLaunchOpts: Array<
  { agent?: { source: string; id: string }; chooseAgent?: boolean } | undefined
> = [];
/** Ordered trace of menu-dismiss vs launch, in call order. See the
 *  "dismisses the host menu before launching" test for why order matters. */
const callOrder: string[] = [];
vi.doMock('./useHandoffDispatch', () => ({
  startAgentThreadForInput: (
    input: HandoffDispatchInput,
    opts?: { agent?: { source: string; id: string }; chooseAgent?: boolean },
  ) => {
    callOrder.push('launch');
    threadLaunchCalls.push(input);
    threadLaunchOpts.push(opts);
  },
  openInstallUrl: () => Promise.resolve(),
}));

const readyInput: HandoffDispatchInput = {
  docContext: { relativePath: 'notes/today.md' },
  docPath: '/project/notes/today.md',
  projectDir: '/project',
};

const launchCalls: Array<{ input: HandoffDispatchInput; cli: string }> = [];

function installStates(
  overrides: Partial<Record<HandoffTarget, InstallState>> = {},
): Record<HandoffTarget, InstallState> {
  return {
    'claude-code': { installed: false, lastChecked: 1 },
    'claude-cowork': { installed: true, lastChecked: 1 },
    codex: { installed: true, lastChecked: 1 },
    cursor: { installed: null, lastChecked: 1 },
    ...overrides,
  };
}

async function renderSubmenu({
  input = readyInput,
  states = installStates(),
  withTerminal = false,
  onBeforeLaunch,
}: {
  input?: HandoffDispatchInput | null;
  states?: Record<HandoffTarget, InstallState>;
  withTerminal?: boolean;
  onBeforeLaunch?: () => void;
} = {}) {
  // Desktop is enablement-gated now (off by default); these tests express
  // Desktop visibility via install state, so enable the installed targets to
  // preserve that intent.
  for (const [id, state] of Object.entries(states)) {
    if (state?.installed === true) setAgentEnabled(desktopEnabledKey(id), true);
  }
  const { OpenInAgentContextSubmenu } = await import('./OpenInAgentContextSubmenu');
  const dispatchCalls: Array<{ input: HandoffDispatchInput; target: HandoffTarget }> = [];
  const dispatch = vi.fn(async (target: HandoffTarget, nextInput: HandoffDispatchInput) => {
    dispatchCalls.push({ input: nextInput, target });
    return { ok: true as const };
  });

  const submenu = (
    <DropdownMenu open={true}>
      <DropdownMenuContent forceMount={true}>
        <OpenInAgentContextSubmenu
          dispatch={dispatch}
          input={input}
          installStates={states}
          isElectronHost={true}
          onBeforeLaunch={onBeforeLaunch}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  render(
    withTerminal ? (
      <TerminalLaunchProvider
        value={{
          launchInTerminal: (i, cli) => launchCalls.push({ input: i, cli }),
          installedClis: {},
        }}
      >
        {submenu}
      </TerminalLaunchProvider>
    ) : (
      submenu
    ),
  );

  const trigger = screen.getByRole('menuitem', { name: 'Open with AI' });
  await userEvent.hover(trigger);
  await waitFor(
    () => {
      expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBeTruthy();
    },
    { timeout: 5000 },
  );

  return { dispatch, dispatchCalls, trigger };
}

describe('OpenInAgentContextSubmenu runtime behavior', () => {
  afterEach(() => {
    cleanup();
    launchCalls.length = 0;
    threadLaunchCalls.length = 0;
    threadLaunchOpts.length = 0;
    callOrder.length = 0;
    // jsdom preload exposes no global localStorage — the store falls back to
    // in-memory state there, so the reload alone resets it; clear the real
    // storage when an environment provides one.
    if (typeof localStorage !== 'undefined') localStorage.clear();
    reloadRegisteredAgentsFromStorage();
    reloadEnabledAgentsFromStorage();
  });

  test('renders only installed visible targets and dispatches the selected row', async () => {
    const { dispatchCalls } = await renderSubmenu();

    const trigger = document.querySelector('[data-slot="dropdown-menu-sub-trigger"]');
    expect(trigger?.textContent).toContain('Open with AI');
    expect(screen.getByTestId('file-tree-open-in-codex')).toBeTruthy();
    expect(screen.queryByTestId('file-tree-open-in-claude-cowork') === null).toBe(true);
    expect(screen.queryByTestId('file-tree-open-in-cursor') === null).toBe(true);
    expect(screen.queryByTestId('file-tree-open-in-claude-web-fallback') === null).toBe(true);

    await userEvent.click(screen.getByRole('menuitem', { name: 'Open with AI Codex' }));

    expect(dispatchCalls).toEqual([{ input: readyInput, target: 'codex' }]);
  });

  test('keeps rows disabled with a No workspace label while input is missing', async () => {
    const { dispatch } = await renderSubmenu({ input: null });

    const codex = screen.getByRole('menuitem', { name: 'Open with AI Codex, No workspace' });
    expect(codex.getAttribute('data-disabled')).toBe('');
    expect(codex.textContent).toContain('No workspace');

    await userEvent.click(codex);

    expect(dispatch).not.toHaveBeenCalled();
  });

  test('renders an installed Claude row (no claude.ai fallback anywhere)', async () => {
    await renderSubmenu({
      states: installStates({
        'claude-code': { installed: true, lastChecked: 1 },
      }),
    });
    expect(screen.getByTestId('file-tree-open-in-claude-code')).toBeTruthy();
    expect(screen.queryByTestId('file-tree-open-in-claude-web-fallback') === null).toBe(true);
  });

  test('hides the In-app section when nothing is enabled, keeping the Configure agents row', async () => {
    await renderSubmenu({
      states: installStates({
        'claude-code': { installed: false, lastChecked: 1 },
        'claude-cowork': { installed: false, lastChecked: 1 },
        codex: { installed: false, lastChecked: 1 },
        cursor: { installed: false, lastChecked: 1 },
      }),
    });
    // No enabled agents (none registered, Desktop off by default) → empty
    // sections are hidden; the Configure agents footer is still reachable.
    expect(screen.queryByTestId('file-tree-open-in-thread')).toBeNull();
    expect(screen.queryByText('No installed agents found')).toBeNull();
    expect(screen.getByTestId('file-tree-open-in-settings')).toBeTruthy();
  });

  test('a per-agent row is disabled with a No workspace hint while input is missing', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    await renderSubmenu({ input: null });
    const row = screen.getByTestId('file-tree-open-in-thread-claude-acp');
    expect(row.getAttribute('data-disabled')).toBe('');
    expect(row.getAttribute('aria-label')).toBe('Start Claude Agent, No workspace');
    await userEvent.click(row);
    expect(threadLaunchCalls).toEqual([]);
  });

  test('registered agents render as one-click rows that launch that agent directly', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    registerAgent({ source: 'registry', id: 'codex-acp', name: 'Codex' });
    await renderSubmenu();

    // The generic picker row is replaced by per-agent rows (+ the Settings row).
    expect(screen.queryByTestId('file-tree-open-in-thread')).toBeNull();
    expect(screen.getByTestId('file-tree-open-in-thread-codex-acp').textContent).toContain(
      'Start Codex',
    );

    await userEvent.click(screen.getByTestId('file-tree-open-in-thread-claude-acp'));
    expect(threadLaunchCalls).toEqual([readyInput]);
    expect(threadLaunchOpts).toEqual([{ agent: { source: 'registry', id: 'claude-acp' } }]);
  });

  test('the Settings row opens Configure agents', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    await renderSubmenu();

    window.location.hash = '';
    await userEvent.click(screen.getByTestId('file-tree-open-in-settings'));
    expect(window.location.hash).toBe('#settings/configure-agents');
    // No thread launch — the Settings row only navigates.
    expect(threadLaunchCalls).toEqual([]);
  });

  // Regression: FileTree's menu is pinned `open` and is torn down only by
  // Pierre's `context.close()`. Launching first leaves that layer alive while
  // the modal catalog mounts, and the resulting focus-restore/dismiss cascade
  // recurses until the renderer hangs (a hard freeze, reproduced in-app). Every
  // launch row must dismiss first, so ORDER is the contract under test — not
  // merely that the callback fired.
  test('dismisses the host menu before launching a registered-agent row', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    await renderSubmenu({ onBeforeLaunch: () => callOrder.push('dismiss') });

    await userEvent.click(screen.getByTestId('file-tree-open-in-thread-claude-acp'));
    expect(callOrder).toEqual(['dismiss', 'launch']);
  });

  test('groups installed agents under Desktop and the CLI launch under Terminal', async () => {
    await renderSubmenu({ withTerminal: true });

    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.getByText('Terminal')).toBeTruthy();
    // Terminal-first: the Terminal section label precedes the Desktop one.
    expect(
      screen.getByText('Terminal').compareDocumentPosition(screen.getByText('Desktop')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Separator divides the two populated sections.
    expect(document.querySelector('[data-slot="dropdown-menu-separator"]')).toBeTruthy();

    const terminalRow = screen.getByTestId('file-tree-open-in-terminal-claude');
    // Visible text is the brand "Claude"; accessible name is "Claude CLI".
    expect(terminalRow.textContent).toContain('Claude');
    expect(terminalRow.textContent).not.toContain('CLI');
    expect(terminalRow.getAttribute('aria-label')).toBe('Claude CLI');
    // Codex + Cursor rows sit alongside, each with its own "<Brand> CLI" name.
    expect(screen.getByTestId('file-tree-open-in-terminal-codex').getAttribute('aria-label')).toBe(
      'Codex CLI',
    );
    expect(screen.getByTestId('file-tree-open-in-terminal-cursor').getAttribute('aria-label')).toBe(
      'Cursor CLI',
    );
  });

  test('terminal row launches via the terminal launcher and does not app-dispatch', async () => {
    const { dispatch } = await renderSubmenu({ withTerminal: true });

    await userEvent.click(screen.getByTestId('file-tree-open-in-terminal-codex'));

    expect(launchCalls).toEqual([{ input: readyInput, cli: 'codex' }]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('terminal row appends the No workspace hint to its accessible name and stays inert while input is missing', async () => {
    await renderSubmenu({ input: null, withTerminal: true });

    const terminalRow = screen.getByTestId('file-tree-open-in-terminal-claude');
    // WCAG 2.5.3: the accessible name must contain the visible label "Claude";
    // when input is missing the hint is appended in this exact order.
    expect(terminalRow.getAttribute('aria-label')).toBe('Claude CLI, No workspace');
    expect(terminalRow.getAttribute('data-disabled')).toBe('');

    await userEvent.click(terminalRow);
    expect(launchCalls).toEqual([]);
  });

  test('omits the Terminal section but keeps Desktop when no terminal launcher is present', async () => {
    await renderSubmenu();

    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.queryByText('Terminal')).toBeNull();
    expect(screen.queryByTestId('file-tree-open-in-terminal-claude')).toBeNull();
  });

  test('renders only the Terminal section (no In app, no Desktop) when nothing else is enabled', async () => {
    await renderSubmenu({
      withTerminal: true,
      states: installStates({
        'claude-code': { installed: false, lastChecked: 1 },
        'claude-cowork': { installed: false, lastChecked: 1 },
        codex: { installed: false, lastChecked: 1 },
        cursor: { installed: false, lastChecked: 1 },
      }),
    });

    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.queryByText('Desktop')).toBeNull();
    // No enabled in-app agents → the In app section is hidden.
    expect(screen.queryByText('In app')).toBeNull();
    expect(screen.getByTestId('file-tree-open-in-terminal-claude')).toBeTruthy();
    // A single separator sits before the Configure agents footer.
    expect(document.querySelectorAll('[data-slot="dropdown-menu-separator"]').length).toBe(1);
  });
});
