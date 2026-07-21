import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
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

vi.doMock('sonner', () => ({
  toast: {
    error: vi.fn(() => {}),
    success: vi.fn(() => {}),
  },
}));

vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({
    merged: { appearance: { preview: { autoOpen: true } } },
  }),
}));

vi.doMock('@/hooks/use-is-embedded', () => ({
  useIsEmbedded: () => false,
}));

const threadLaunchCalls: HandoffDispatchInput[] = [];
const threadLaunchOpts: Array<
  { agent?: { source: string; id: string }; chooseAgent?: boolean } | undefined
> = [];
vi.doMock('./useHandoffDispatch', () => ({
  startAgentThreadForInput: (
    input: HandoffDispatchInput,
    opts?: { agent?: { source: string; id: string }; chooseAgent?: boolean },
  ) => {
    threadLaunchCalls.push(input);
    threadLaunchOpts.push(opts);
  },
  openInstallUrl: () => Promise.resolve(),
}));

const readyInput: HandoffDispatchInput = {
  docContext: null,
  docPath: '',
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
}: {
  input?: HandoffDispatchInput | null;
  states?: Record<HandoffTarget, InstallState>;
  withTerminal?: boolean;
} = {}) {
  for (const [id, state] of Object.entries(states)) {
    if (state?.installed === true) setAgentEnabled(desktopEnabledKey(id), true);
  }
  const { OpenInAgentEmptySpaceSubmenu } = await import('./OpenInAgentEmptySpaceSubmenu');
  const dispatchCalls: Array<{ input: HandoffDispatchInput; target: HandoffTarget }> = [];
  const dispatch = vi.fn(async (target: HandoffTarget, nextInput: HandoffDispatchInput) => {
    dispatchCalls.push({ input: nextInput, target });
    return { ok: true as const };
  });

  const menu = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button">Project files</button>
      </ContextMenuTrigger>
      <ContextMenuContent forceMount={true}>
        <OpenInAgentEmptySpaceSubmenu dispatch={dispatch} input={input} installStates={states} />
      </ContextMenuContent>
    </ContextMenu>
  );

  render(
    withTerminal ? (
      <TerminalLaunchProvider
        value={{
          launchInTerminal: (i, cli) => launchCalls.push({ input: i, cli }),
          installedClis: {},
        }}
      >
        {menu}
      </TerminalLaunchProvider>
    ) : (
      menu
    ),
  );

  await act(async () => {
    fireEvent.contextMenu(screen.getByText('Project files'));
    await Promise.resolve();
  });

  return { dispatch, dispatchCalls };
}

async function openEmptySpaceSubmenu() {
  const trigger = screen.getByRole('menuitem', { name: 'Open with AI' });
  await userEvent.hover(trigger);
  await waitFor(
    () => {
      expect(document.querySelector('[data-slot="context-menu-sub-content"]')).toBeTruthy();
    },
    { timeout: 5000 },
  );
  return trigger;
}

describe('OpenInAgentEmptySpaceSubmenu runtime behavior', () => {
  afterEach(() => {
    cleanup();
    launchCalls.length = 0;
    threadLaunchCalls.length = 0;
    threadLaunchOpts.length = 0;
    // jsdom preload exposes no global localStorage — the store falls back to
    // in-memory state there, so the reload alone resets it; clear the real
    // storage when an environment provides one.
    if (typeof localStorage !== 'undefined') localStorage.clear();
    reloadRegisteredAgentsFromStorage();
    reloadEnabledAgentsFromStorage();
  });

  test('renders as a ContextMenu submenu, filters visible installed targets, and dispatches rows', async () => {
    const { dispatchCalls } = await renderSubmenu();
    const trigger = await openEmptySpaceSubmenu();

    expect(trigger.getAttribute('data-slot')).toBe('context-menu-sub-trigger');
    expect(document.querySelector('[data-slot="dropdown-menu-sub-trigger"]') === null).toBe(true);
    expect(screen.getByTestId('empty-space-open-in-codex')).toBeTruthy();
    expect(screen.queryByTestId('empty-space-open-in-claude-cowork') === null).toBe(true);
    expect(screen.queryByTestId('empty-space-open-in-cursor') === null).toBe(true);
    expect(screen.queryByTestId('empty-space-open-in-claude-web-fallback') === null).toBe(true);

    await userEvent.click(screen.getByRole('menuitem', { name: 'Open with AI Codex' }));

    expect(dispatchCalls).toEqual([{ input: readyInput, target: 'codex' }]);
  });

  test('keeps rows disabled with a No workspace label while input is missing', async () => {
    const { dispatch } = await renderSubmenu({ input: null });
    await openEmptySpaceSubmenu();

    const codex = screen.getByRole('menuitem', { name: 'Open with AI Codex, No workspace' });
    expect(codex.getAttribute('data-disabled')).toBe('');
    expect(codex.textContent).toContain('No workspace');

    await userEvent.click(codex);

    expect(dispatch).not.toHaveBeenCalled();
  });

  test('hides the In-app section when nothing is enabled, keeping the Configure agents row', async () => {
    // Web-host path (no terminal), everything uninstalled, no agents enabled:
    // empty sections are hidden and the Configure agents footer stays reachable.
    await renderSubmenu({
      states: installStates({
        'claude-code': { installed: false, lastChecked: 1 },
        'claude-cowork': { installed: false, lastChecked: 1 },
        codex: { installed: false, lastChecked: 1 },
        cursor: { installed: false, lastChecked: 1 },
      }),
    });
    await openEmptySpaceSubmenu();
    expect(screen.queryByTestId('empty-space-open-in-thread')).toBeNull();
    expect(screen.getByTestId('empty-space-open-in-settings')).toBeTruthy();
  });

  test('a per-agent row is disabled with a No workspace hint while input is missing', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    await renderSubmenu({ input: null });
    await openEmptySpaceSubmenu();
    const row = screen.getByTestId('empty-space-open-in-thread-claude-acp');
    expect(row.getAttribute('data-disabled')).toBe('');
    expect(row.getAttribute('aria-label')).toBe('Start Claude Agent, No workspace');
    await userEvent.click(row);
    expect(threadLaunchCalls).toEqual([]);
  });

  test('registered agents render as one-click rows that launch that agent directly', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    await renderSubmenu();
    await openEmptySpaceSubmenu();

    expect(screen.queryByTestId('empty-space-open-in-thread')).toBeNull();
    await userEvent.click(screen.getByTestId('empty-space-open-in-thread-claude-acp'));
    expect(threadLaunchCalls).toEqual([readyInput]);
    expect(threadLaunchOpts).toEqual([{ agent: { source: 'registry', id: 'claude-acp' } }]);
  });

  test('the Settings row opens Configure agents', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    await renderSubmenu();
    await openEmptySpaceSubmenu();

    window.location.hash = '';
    await userEvent.click(screen.getByTestId('empty-space-open-in-settings'));
    expect(window.location.hash).toBe('#settings/configure-agents');
    // No thread launch — the Settings row only navigates.
    expect(threadLaunchCalls).toEqual([]);
  });

  test('groups installed agents under Desktop and the CLI launch under Terminal', async () => {
    await renderSubmenu({ withTerminal: true });
    await openEmptySpaceSubmenu();

    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.getByText('Terminal')).toBeTruthy();
    // Terminal-first: the Terminal section label precedes the Desktop one.
    expect(
      screen.getByText('Terminal').compareDocumentPosition(screen.getByText('Desktop')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Separator divides the two populated sections.
    expect(document.querySelector('[data-slot="context-menu-separator"]')).toBeTruthy();

    const terminalRow = screen.getByTestId('empty-space-open-in-terminal-claude');
    // Visible text is the brand "Claude"; accessible name is "Claude CLI".
    expect(terminalRow.textContent).toContain('Claude');
    expect(terminalRow.textContent).not.toContain('CLI');
    expect(terminalRow.getAttribute('aria-label')).toBe('Claude CLI');
    // Codex + Cursor rows sit alongside, each with its own "<Brand> CLI" name.
    expect(
      screen.getByTestId('empty-space-open-in-terminal-codex').getAttribute('aria-label'),
    ).toBe('Codex CLI');
    expect(
      screen.getByTestId('empty-space-open-in-terminal-cursor').getAttribute('aria-label'),
    ).toBe('Cursor CLI');
  });

  test('terminal row launches via the terminal launcher and does not app-dispatch', async () => {
    const { dispatch } = await renderSubmenu({ withTerminal: true });
    await openEmptySpaceSubmenu();

    await userEvent.click(screen.getByTestId('empty-space-open-in-terminal-cursor'));

    expect(launchCalls).toEqual([{ input: readyInput, cli: 'cursor' }]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('terminal row appends the No workspace hint to its accessible name and stays inert while input is missing', async () => {
    await renderSubmenu({ input: null, withTerminal: true });
    await openEmptySpaceSubmenu();

    const terminalRow = screen.getByTestId('empty-space-open-in-terminal-claude');
    // WCAG 2.5.3: the accessible name must contain the visible label "Claude";
    // when input is missing the hint is appended in this exact order.
    expect(terminalRow.getAttribute('aria-label')).toBe('Claude CLI, No workspace');
    expect(terminalRow.getAttribute('data-disabled')).toBe('');

    await userEvent.click(terminalRow);
    expect(launchCalls).toEqual([]);
  });

  test('omits the Terminal section but keeps Desktop when no terminal launcher is present', async () => {
    await renderSubmenu();
    await openEmptySpaceSubmenu();

    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.queryByText('Terminal')).toBeNull();
    expect(screen.queryByTestId('empty-space-open-in-terminal-claude')).toBeNull();
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
    await openEmptySpaceSubmenu();

    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.queryByText('Desktop')).toBeNull();
    expect(screen.queryByText('In app')).toBeNull();
    expect(screen.getByTestId('empty-space-open-in-terminal-claude')).toBeTruthy();
    // A single separator sits before the Configure agents footer.
    expect(document.querySelectorAll('[data-slot="context-menu-separator"]').length).toBe(1);
  });
});
