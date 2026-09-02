import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { HandoffDispatchInput } from './useHandoffDispatch';

const input: HandoffDispatchInput = {
  docContext: { relativePath: 'docs/notes.md' },
  projectDir: '/tmp/project',
  docPath: '/tmp/project/docs/notes.md',
};

const installedStates = {
  'claude-cowork': { installed: true, lastChecked: 1 },
  'claude-code': { installed: true, lastChecked: 1 },
  codex: { installed: true, lastChecked: 1 },
  cursor: { installed: true, lastChecked: 1 },
};

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

vi.doMock('./useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: installedStates, refresh: () => Promise.resolve() }),
}));

vi.doMock('./useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({ dispatch: () => Promise.resolve({ ok: true as const }) }),
  composeThreadLaunchPrompt: (dispatchInput: HandoffDispatchInput) =>
    `thread-prompt:${dispatchInput.docContext?.relativePath ?? 'none'}`,
  startAgentThreadForInput: () => {},
  openInstallUrl: () => Promise.resolve(),
}));

vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: { appearance: { preview: { autoOpen: true } } } }),
}));

vi.doMock('@/hooks/use-is-embedded', () => ({ useIsEmbedded: () => false }));

vi.doMock('./OpenInAgentMenuItem', () => ({ TargetIcon: () => null }));

const { OpenInAgentMenu } = await import('./OpenInAgentMenu');
const { TerminalLaunchProvider } = await import('./TerminalLaunchContext');

type LaunchCall = { input: HandoffDispatchInput; cli: TerminalCli };

async function renderMenu(opts: {
  launcher: ((input: HandoffDispatchInput, cli: TerminalCli) => void) | null;
  menuInput?: HandoffDispatchInput | null;
  installedClis?: Partial<Record<TerminalCli, boolean>>;
}) {
  const menuInput = 'menuInput' in opts ? opts.menuInput : input;
  render(
    <TerminalLaunchProvider
      value={
        opts.launcher
          ? { launchInTerminal: opts.launcher, installedClis: opts.installedClis ?? {} }
          : null
      }
    >
      <OpenInAgentMenu input={menuInput ?? null} />
    </TerminalLaunchProvider>,
  );
}

async function openMenu() {
  await userEvent.click(screen.getByTestId('open-in-agent-trigger'));
  await waitFor(() => {
    expect(screen.getByTestId('open-in-agent-menu')).toBeTruthy();
  });
}

describe('Open-with-AI Terminal CLI rows', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders a row per CLI when the launcher is available (desktop)', async () => {
    await renderMenu({ launcher: () => {} });
    await openMenu();
    expect(screen.getByTestId('open-in-agent-terminal-claude')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-terminal-codex')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-terminal-cursor')).toBeTruthy();
  });

  test('gates rows through the real probe map: probed-absent hidden (Claude included), detected shown', async () => {
    await renderMenu({
      launcher: () => {},
      installedClis: {
        claude: false,
        codex: true,
        opencode: false,
        cursor: false,
        pi: false,
        antigravity: false,
      },
    });
    await openMenu();
    expect(screen.queryByTestId('open-in-agent-terminal-claude')).toBeNull();
    expect(screen.getByTestId('open-in-agent-terminal-codex')).toBeTruthy();
    expect(screen.queryByTestId('open-in-agent-terminal-antigravity')).toBeNull();
    expect(screen.queryByTestId('open-in-agent-terminal-cursor')).toBeNull();
  });

  test('fails open before the probe resolves (empty map) — installed CLIs stay launchable', async () => {
    await renderMenu({ launcher: () => {}, installedClis: {} });
    await openMenu();
    expect(screen.getByTestId('open-in-agent-terminal-claude')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-terminal-codex')).toBeTruthy();
    expect(screen.getByTestId('open-in-agent-terminal-cursor')).toBeTruthy();
  });

  test('hides the terminal section when no launcher is available (web host)', async () => {
    await renderMenu({ launcher: null });
    await openMenu();
    expect(screen.queryByTestId('open-in-agent-terminal-claude')).toBeNull();
    expect(screen.queryByTestId('open-in-agent-terminal-codex')).toBeNull();
  });

  test('clicking a row hands the bare handoff input + chosen CLI to the launcher', async () => {
    const calls: LaunchCall[] = [];
    await renderMenu({ launcher: (i, cli) => calls.push({ input: i, cli }) });
    await openMenu();
    await userEvent.click(screen.getByTestId('open-in-agent-terminal-codex'));
    expect(calls).toStrictEqual([{ input, cli: 'codex' }]);
  });

  test('the trigger is disabled when there is no handoff input', async () => {
    await renderMenu({ launcher: () => {}, menuInput: null });
    const trigger = screen.getByTestId('open-in-agent-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });
});
