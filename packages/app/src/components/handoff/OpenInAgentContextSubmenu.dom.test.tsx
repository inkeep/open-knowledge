import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { TerminalLaunchProvider } from './TerminalLaunchContext';
import type { HandoffDispatchInput } from './useHandoffDispatch';

mock.module('@lingui/core/macro', () => ({
  t: renderLinguiTemplate,
}));

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: { appearance: { preview: { autoOpen: true } } },
  }),
}));

mock.module('@/lib/config-context', () => ({
  useConfigContext: () => ({
    merged: { appearance: { preview: { autoOpen: true } } },
  }),
}));

mock.module('sonner', () => ({
  toast: {
    error: mock(() => {}),
    success: mock(() => {}),
  },
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
}: {
  input?: HandoffDispatchInput | null;
  states?: Record<HandoffTarget, InstallState>;
  withTerminal?: boolean;
} = {}) {
  const { OpenInAgentContextSubmenu } = await import('./OpenInAgentContextSubmenu');
  const dispatchCalls: Array<{ input: HandoffDispatchInput; target: HandoffTarget }> = [];
  const dispatch = mock(async (target: HandoffTarget, nextInput: HandoffDispatchInput) => {
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
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  render(
    withTerminal ? (
      <TerminalLaunchProvider
        value={{ launchInTerminal: (i, cli) => launchCalls.push({ input: i, cli }) }}
      >
        {submenu}
      </TerminalLaunchProvider>
    ) : (
      submenu
    ),
  );

  const trigger = screen.getByRole('menuitem', { name: 'Open with AI' });
  await userEvent.hover(trigger);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBeTruthy();
  });

  return { dispatch, dispatchCalls, trigger };
}

describe('OpenInAgentContextSubmenu runtime behavior', () => {
  afterEach(() => {
    cleanup();
    launchCalls.length = 0;
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

  test('shows the empty hint when no targets are installed', async () => {
    await renderSubmenu({
      states: installStates({
        'claude-code': { installed: false, lastChecked: 1 },
        'claude-cowork': { installed: false, lastChecked: 1 },
        codex: { installed: false, lastChecked: 1 },
        cursor: { installed: false, lastChecked: 1 },
      }),
    });
    const empty = screen.getByTestId('file-tree-open-in-empty');
    expect(empty.textContent).toContain('No installed agents found');
  });

  test('shows the checking hint while the install probe is pending', async () => {
    await renderSubmenu({
      states: installStates({
        'claude-code': { installed: null },
        'claude-cowork': { installed: null },
        codex: { installed: null },
        cursor: { installed: null },
      }),
    });
    const empty = screen.getByTestId('file-tree-open-in-empty');
    expect(empty.textContent).toContain('Checking for installed agents');
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

  test('renders only the Terminal section (no Desktop label, no separator) when no agents are installed', async () => {
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
    expect(screen.getByTestId('file-tree-open-in-terminal-claude')).toBeTruthy();
    expect(document.querySelector('[data-slot="dropdown-menu-separator"]')).toBeNull();
  });
});
