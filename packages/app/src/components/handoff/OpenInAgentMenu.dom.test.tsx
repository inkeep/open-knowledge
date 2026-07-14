import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TerminalLaunchProvider } from './TerminalLaunchContext';
import type { HandoffDispatchInput } from './useHandoffDispatch';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const refreshCalls: string[] = [];
const dispatchCalls: Array<{ target: string; input: HandoffDispatchInput }> = [];
const launchCalls: Array<{ input: HandoffDispatchInput; cli: string }> = [];
let states: Record<string, { installed: boolean | null; lastChecked?: number }> = {};

mock.module('./useInstalledAgents', () => ({
  useInstalledAgents: () => ({
    states,
    refresh: () => {
      refreshCalls.push('refresh');
      return Promise.resolve();
    },
  }),
}));

mock.module('./useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({
    dispatch: (target: string, input: HandoffDispatchInput) => {
      dispatchCalls.push({ target, input });
      return Promise.resolve({ ok: true as const });
    },
  }),
}));

mock.module('@/lib/config-context', () => ({
  useConfigContext: () => ({
    merged: { appearance: { preview: { autoOpen: true } } },
  }),
}));

mock.module('@/hooks/use-is-embedded', () => ({
  useIsEmbedded: () => false,
}));

// The popover renders its own agent rows now and only pulls `TargetIcon` from
// this module (which transitively imports `next-themes`); stub it so the mount
// stays provider-free.
mock.module('./OpenInAgentMenuItem', () => ({
  TargetIcon: () => null,
}));

const input: HandoffDispatchInput = {
  docContext: { relativePath: 'docs/notes.md' },
  projectDir: '/tmp/project',
  docPath: '/tmp/project/docs/notes.md',
};

async function renderMenu(menuInput: HandoffDispatchInput | null = input) {
  const { OpenInAgentMenu } = await import('./OpenInAgentMenu');
  render(
    <TooltipProvider>
      <OpenInAgentMenu input={menuInput} />
    </TooltipProvider>,
  );
}

async function renderMenuWithTerminal(menuInput: HandoffDispatchInput | null = input) {
  const { OpenInAgentMenu } = await import('./OpenInAgentMenu');
  render(
    <TooltipProvider>
      <TerminalLaunchProvider
        value={{
          launchInTerminal: (i, cli) => launchCalls.push({ input: i, cli }),
          installedClis: {},
        }}
      >
        <OpenInAgentMenu input={menuInput} />
      </TerminalLaunchProvider>
    </TooltipProvider>,
  );
}

async function openMenu() {
  await userEvent.click(screen.getByTestId('open-in-agent-trigger'));
  await waitFor(() => {
    expect(screen.getByTestId('open-in-agent-menu')).toBeTruthy();
  });
}

describe('OpenInAgentMenu runtime behavior', () => {
  afterEach(() => {
    cleanup();
    refreshCalls.length = 0;
    dispatchCalls.length = 0;
    launchCalls.length = 0;
    states = {};
  });

  test('exports the shell component', async () => {
    const mod = await import('./OpenInAgentMenu');
    expect(typeof mod.OpenInAgentMenu).toBe('function');
  });

  test('trigger uses visible Open with AI text as its accessible name', async () => {
    await renderMenu();

    const trigger = screen.getByTestId('open-in-agent-trigger');
    expect(trigger.textContent).toContain('Open with AI');
    expect(trigger.getAttribute('aria-label')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open with AI' })).toBe(trigger);
  });

  test('disabled trigger still keeps the visible Open with AI label when no input exists', async () => {
    await renderMenu(null);

    const trigger = screen.getByRole('button', { name: 'Open with AI' }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute('aria-label')).toBeNull();
  });

  test('open refreshes install state and renders only installed visible targets', async () => {
    states = {
      'claude-cowork': { installed: true, lastChecked: 1 },
      'claude-code': { installed: true, lastChecked: 1 },
      codex: { installed: true, lastChecked: 1 },
      cursor: { installed: true, lastChecked: 1 },
    };
    await renderMenu();
    await openMenu();

    expect(refreshCalls).toEqual(['refresh']);
    expect(screen.getByTestId('open-in-agent-item-claude-code')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-item-codex')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-item-cursor')).toBeTruthy();
    expect(screen.queryByTestId('open-in-agent-item-claude-cowork')).toBeNull();

    // The "Desktop" section label renders above the app-agent rows (assert before
    // the click, which closes the popover and unmounts the panel).
    expect(screen.getByTestId('open-in-agent-desktop-label').textContent).toContain('Desktop');

    // No instruction typed → the bare input dispatches unchanged. `toStrictEqual`
    // (not `toEqual`) proves no `instruction` key was added: strict equality
    // rejects an extra `instruction: undefined` key, whereas `toEqual` treats an
    // undefined-valued key as absent and would miss that regression.
    await userEvent.click(screen.getByTestId('open-in-agent-item-codex'));
    expect(dispatchCalls).toStrictEqual([{ target: 'codex', input }]);
  });

  test('typing an instruction threads it onto the dispatched input', async () => {
    states = {
      'claude-cowork': { installed: true, lastChecked: 1 },
      'claude-code': { installed: true, lastChecked: 1 },
      codex: { installed: true, lastChecked: 1 },
      cursor: { installed: true, lastChecked: 1 },
    };
    await renderMenu();
    await openMenu();

    await userEvent.type(screen.getByTestId('open-in-agent-instruction'), 'Tighten the intro');
    await userEvent.click(screen.getByTestId('open-in-agent-item-cursor'));

    expect(dispatchCalls).toStrictEqual([
      { target: 'cursor', input: { ...input, instruction: 'Tighten the intro' } },
    ]);
  });

  test('instruction input resets to empty when the popover is reopened', async () => {
    // Pins the documented reset-on-remount contract: the popover unmounts its
    // content when closed, so the instruction never persists across opens. A
    // future change making the panel persistent (e.g. for animation) would
    // break this silently.
    states = {
      'claude-cowork': { installed: true, lastChecked: 1 },
      'claude-code': { installed: true, lastChecked: 1 },
      codex: { installed: true, lastChecked: 1 },
      cursor: { installed: true, lastChecked: 1 },
    };
    await renderMenu();
    await openMenu();
    await userEvent.type(screen.getByTestId('open-in-agent-instruction'), 'Tighten the intro');
    // Dispatching closes the popover (unmounts the panel).
    await userEvent.click(screen.getByTestId('open-in-agent-item-codex'));

    await userEvent.click(screen.getByTestId('open-in-agent-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('open-in-agent-menu')).toBeTruthy();
    });
    expect((screen.getByTestId('open-in-agent-instruction') as HTMLInputElement).value).toBe('');
  });

  test('a whitespace-only instruction is treated as empty (no instruction key)', async () => {
    states = {
      'claude-cowork': { installed: true, lastChecked: 1 },
      'claude-code': { installed: true, lastChecked: 1 },
      codex: { installed: true, lastChecked: 1 },
      cursor: { installed: true, lastChecked: 1 },
    };
    await renderMenu();
    await openMenu();

    await userEvent.type(screen.getByTestId('open-in-agent-instruction'), '   ');
    await userEvent.click(screen.getByTestId('open-in-agent-item-codex'));
    // `toStrictEqual` against the bare `input` proves no `instruction` key was
    // added — strict equality distinguishes `instruction: undefined` from
    // key-absent, which `toEqual` would not.
    expect(dispatchCalls).toStrictEqual([{ target: 'codex', input }]);
  });

  test('shows the empty hint (no claude.ai fallback) when nothing is installed', async () => {
    states = {
      'claude-cowork': { installed: false, lastChecked: 1 },
      'claude-code': { installed: false, lastChecked: 1 },
      codex: { installed: false, lastChecked: 1 },
      cursor: { installed: false, lastChecked: 1 },
    };
    await renderMenu();
    await openMenu();

    // No terminal launcher in the test (no provider → web-host path), so the
    // disabled empty hint renders. The removed claude.ai web fallback must not.
    const empty = screen.getByTestId('open-in-agent-empty');
    expect(empty.textContent).toContain('No installed agents found');
    expect(screen.queryByTestId('open-in-agent-claude-web-fallback')).toBeNull();
  });

  test('shows the checking hint while the install probe is pending', async () => {
    states = {
      'claude-cowork': { installed: null },
      'claude-code': { installed: null },
      codex: { installed: null },
      cursor: { installed: null },
    };
    await renderMenu();
    await openMenu();

    const empty = screen.getByTestId('open-in-agent-empty');
    expect(empty.textContent).toContain('Checking for installed agents');
  });

  test('groups installed agents under Desktop and the CLI launch under Terminal', async () => {
    states = {
      'claude-code': { installed: true, lastChecked: 1 },
      codex: { installed: true, lastChecked: 1 },
      cursor: { installed: true, lastChecked: 1 },
    };
    await renderMenuWithTerminal();
    await openMenu();

    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-terminal-claude')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-terminal-codex')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-terminal-cursor')).toBeTruthy();
    // Each section is a named role="group" (via <fieldset>/<legend>) so
    // assistive tech announces it.
    expect(screen.getByRole('group', { name: 'Desktop' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Terminal' })).toBeTruthy();
    // Terminal-first: the Terminal section label precedes the Desktop one.
    const terminalLabel = screen.getByTestId('open-in-agent-terminal-label');
    const desktopLabel = screen.getByTestId('open-in-agent-desktop-label');
    expect(
      terminalLabel.compareDocumentPosition(desktopLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('terminal row launches via the terminal launcher with the menu input', async () => {
    states = { 'claude-code': { installed: true, lastChecked: 1 } };
    await renderMenuWithTerminal();
    await openMenu();

    await userEvent.click(screen.getByTestId('open-in-agent-terminal-claude'));
    expect(launchCalls).toEqual([{ input, cli: 'claude' }]);
    // The terminal launch is distinct from the app deep-link dispatch.
    expect(dispatchCalls).toEqual([]);
  });

  test('omits the Terminal section but keeps Desktop when no terminal launcher is present', async () => {
    states = { 'claude-code': { installed: true, lastChecked: 1 } };
    await renderMenu();
    await openMenu();

    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.queryByText('Terminal')).toBeNull();
    expect(screen.queryByTestId('open-in-agent-terminal-claude')).toBeNull();
  });
});
