import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { RegisteredAgent } from '@/lib/acp/registered-agents';
import type { NewSessionChoice } from '@/lib/new-session-choice';
import { TerminalNewChatButton } from './TerminalNewChatButton';

const AGENT_A: RegisteredAgent = { source: 'registry', id: 'agent-a', name: 'Agent A' };
const AGENT_B: RegisteredAgent = { source: 'registry', id: 'agent-b', name: 'Agent B' };

function renderButton(overrides: Partial<React.ComponentProps<typeof TerminalNewChatButton>> = {}) {
  const onLaunchSelected = vi.fn(() => {});
  const onPickCli = vi.fn((_cli: TerminalCli) => {});
  const onPickTerminal = vi.fn(() => {});
  const onPickAgent = vi.fn((_agent: RegisteredAgent) => {});
  const onOpenSettings = vi.fn(() => {});
  const selected: NewSessionChoice = overrides.selected ?? { kind: 'cli', cli: 'claude' };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TerminalNewChatButton
          selected={selected}
          onLaunchSelected={onLaunchSelected}
          showAgents={overrides.showAgents ?? true}
          registeredAgents={overrides.registeredAgents ?? [AGENT_A, AGENT_B]}
          onPickAgent={onPickAgent}
          onOpenSettings={onOpenSettings}
          liveThreadCount={overrides.liveThreadCount ?? 0}
          showClis={overrides.showClis ?? true}
          onPickCli={onPickCli}
          onPickTerminal={onPickTerminal}
          visibleClis={overrides.visibleClis}
          presentation={overrides.presentation}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onLaunchSelected, onPickCli, onPickTerminal, onPickAgent, onOpenSettings };
}

describe('TerminalNewChatButton (merged sessions-dock New button)', () => {
  afterEach(() => cleanup());

  test('the primary launches the current selection (a CLI) without changing it', async () => {
    const user = userEvent.setup();
    const { onLaunchSelected, onPickCli } = renderButton({
      selected: { kind: 'cli', cli: 'codex' },
    });

    await user.click(screen.getByRole('button', { name: 'New Codex chat' }));

    expect(onLaunchSelected).toHaveBeenCalledTimes(1);
    expect(onPickCli).not.toHaveBeenCalled();
  });

  test('the panel presentation reuses the full-width split button without a plus icon', () => {
    renderButton({ presentation: 'panel', selected: { kind: 'agent', agent: AGENT_A } });

    const primary = screen.getByTestId('terminal-new-chat');
    const group = primary.closest('[data-slot="button-group"]');
    expect(group).not.toBeNull();
    expect(group?.className).toContain('w-full');
    expect(primary.querySelector('[data-lucide="plus"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose what a new chat starts' })).toBeDefined();
  });

  test.each([
    [{ kind: 'agent', agent: AGENT_A } as NewSessionChoice, 'New chat with Agent A', 'New chat'],
    [{ kind: 'cli', cli: 'codex' } as NewSessionChoice, 'New Codex chat', 'New Codex chat'],
    [{ kind: 'terminal' } as NewSessionChoice, 'New terminal', 'New terminal'],
  ])(
    'the panel primary names its target and a user can read that name on the control',
    (selected, accessibleName, visibleName) => {
      renderButton({ presentation: 'panel', selected });

      const primary = screen.getByRole('button', { name: accessibleName });
      expect(primary.getAttribute('data-testid')).toBe('terminal-new-chat');
      expect(primary.textContent).toContain(visibleName);
    },
  );

  test('the panel dropdown keeps the bare Terminal row beside the CLI rows', async () => {
    const user = userEvent.setup();
    const { onPickTerminal } = renderButton({ presentation: 'panel' });

    await user.click(screen.getByRole('button', { name: 'Choose what a new chat starts' }));

    for (const name of ['Claude CLI', 'Codex CLI', 'OpenCode CLI']) {
      expect(await screen.findByRole('menuitem', { name })).toBeDefined();
    }
    const terminalRow = screen.getByTestId('terminal-new-chat-terminal');
    expect(terminalRow).toBeDefined();

    await user.click(terminalRow);
    expect(onPickTerminal).toHaveBeenCalledTimes(1);
  });

  test('when Terminal is the selection the primary opens a bare terminal', async () => {
    const user = userEvent.setup();
    const { onLaunchSelected } = renderButton({ selected: { kind: 'terminal' } });

    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(onLaunchSelected).toHaveBeenCalledTimes(1);
  });

  test('when an agent is selected the visible label stays concise and the accessible name is specific', () => {
    renderButton({ selected: { kind: 'agent', agent: AGENT_A } });
    const primary = screen.getByRole('button', { name: 'New chat with Agent A' });
    expect(primary.textContent).not.toContain('Agent A');
  });

  test('the dropdown lists registered agents, Configure agents, every available CLI, and Terminal', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));

    expect(await screen.findByRole('menuitem', { name: 'Agent A' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Agent B' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Configure agents' })).toBeDefined();
    for (const name of [
      'Claude CLI',
      'Codex CLI',
      'GitHub Copilot CLI',
      'OpenCode CLI',
      'Cursor CLI',
    ]) {
      expect(screen.getByRole('menuitem', { name })).toBeDefined();
    }
    expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeDefined();
  });

  test('names the In app group "In app" and carries no maturity badge', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));

    const inApp = await screen.findByRole('group', { name: 'In app' });
    expect(inApp.textContent).toContain('In app');
    expect(inApp.textContent).not.toContain('Beta');
  });

  test('lists only the CLIs in visibleClis (Claude + detected), hiding the rest', async () => {
    const user = userEvent.setup();
    renderButton({ visibleClis: ['claude', 'codex'] });

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));

    expect(await screen.findByRole('menuitem', { name: 'Claude CLI' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Codex CLI' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'OpenCode CLI' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'GitHub Copilot CLI' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Antigravity CLI' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Cursor CLI' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeDefined();
  });

  test('web surface (showClis=false) hides the CLI + Terminal rows', async () => {
    const user = userEvent.setup();
    renderButton({ showClis: false });

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));

    expect(await screen.findByRole('menuitem', { name: 'Agent A' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Claude CLI' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Terminal' })).toBeNull();
  });

  test('terminal window surface (showAgents=false) hides the agent rows', async () => {
    const user = userEvent.setup();
    renderButton({ showAgents: false });

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));

    expect(await screen.findByRole('menuitem', { name: 'Claude CLI' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Agent A' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Configure agents' })).toBeNull();
  });

  test('picking a CLI switches the default (persist + launch), not the primary', async () => {
    const user = userEvent.setup();
    const { onPickCli, onLaunchSelected, onPickTerminal } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'OpenCode CLI' }));

    expect(onPickCli).toHaveBeenCalledTimes(1);
    expect(onPickCli).toHaveBeenCalledWith('opencode');
    expect(onLaunchSelected).not.toHaveBeenCalled();
    expect(onPickTerminal).not.toHaveBeenCalled();
  });

  test('picking a registered agent switches the default (persist + launch)', async () => {
    const user = userEvent.setup();
    const { onPickAgent, onLaunchSelected } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Agent B' }));

    expect(onPickAgent).toHaveBeenCalledTimes(1);
    expect(onPickAgent).toHaveBeenCalledWith(AGENT_B);
    expect(onLaunchSelected).not.toHaveBeenCalled();
  });

  test('"Configure agents" opens the settings tab', async () => {
    const user = userEvent.setup();
    const { onOpenSettings } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Configure agents' }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test('marks the selected agent / CLI / terminal row current via aria-current', async () => {
    const user = userEvent.setup();
    renderButton({ selected: { kind: 'agent', agent: AGENT_A } });

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));

    expect(
      (await screen.findByRole('menuitem', { name: 'Agent A' })).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      screen.getByRole('menuitem', { name: 'Agent B' }).getAttribute('aria-current'),
    ).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: 'Terminal' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  test('picking Terminal switches the default to a bare shell', async () => {
    const user = userEvent.setup();
    const { onPickTerminal, onPickCli, onLaunchSelected } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new tab starts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Terminal' }));

    expect(onPickTerminal).toHaveBeenCalledTimes(1);
    expect(onPickCli).not.toHaveBeenCalled();
    expect(onLaunchSelected).not.toHaveBeenCalled();
  });
});
