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
  // A QueryClient with no network — the catalog query stays disabled/idle in tests,
  // so the cap defaults to 8 and no agent row is disabled.
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

  test('when Terminal is the selection the primary opens a bare terminal', async () => {
    const user = userEvent.setup();
    const { onLaunchSelected } = renderButton({ selected: { kind: 'terminal' } });

    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(onLaunchSelected).toHaveBeenCalledTimes(1);
  });

  test('when an agent is the selection the primary reads "New <agent> chat"', () => {
    renderButton({ selected: { kind: 'agent', agent: AGENT_A } });
    expect(screen.getByRole('button', { name: 'New Agent A chat' })).toBeDefined();
  });

  test('the dropdown lists registered agents, Configure agents, every available CLI, and Terminal', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));

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

  test('lists only the CLIs in visibleClis (Claude + detected), hiding the rest', async () => {
    const user = userEvent.setup();
    // The host passes the already-gated list (via `isTerminalCliEnabled`): here
    // Claude plus detected Codex. Undetected CLIs are absent.
    renderButton({ visibleClis: ['claude', 'codex'] });

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));

    expect(await screen.findByRole('menuitem', { name: 'Claude CLI' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Codex CLI' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'OpenCode CLI' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'GitHub Copilot CLI' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Antigravity CLI' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Cursor CLI' })).toBeNull();
    // The bare-shell Terminal row is independent of CLI gating — always present.
    expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeDefined();
  });

  test('web surface (showClis=false) hides the CLI + Terminal rows', async () => {
    const user = userEvent.setup();
    renderButton({ showClis: false });

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));

    expect(await screen.findByRole('menuitem', { name: 'Agent A' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Claude CLI' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Terminal' })).toBeNull();
  });

  test('terminal window surface (showAgents=false) hides the agent rows', async () => {
    const user = userEvent.setup();
    renderButton({ showAgents: false });

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));

    expect(await screen.findByRole('menuitem', { name: 'Claude CLI' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Agent A' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Configure agents' })).toBeNull();
  });

  test('picking a CLI switches the default (persist + launch), not the primary', async () => {
    const user = userEvent.setup();
    const { onPickCli, onLaunchSelected, onPickTerminal } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'OpenCode CLI' }));

    expect(onPickCli).toHaveBeenCalledTimes(1);
    expect(onPickCli).toHaveBeenCalledWith('opencode');
    expect(onLaunchSelected).not.toHaveBeenCalled();
    expect(onPickTerminal).not.toHaveBeenCalled();
  });

  test('picking a registered agent switches the default (persist + launch)', async () => {
    const user = userEvent.setup();
    const { onPickAgent, onLaunchSelected } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Agent B' }));

    expect(onPickAgent).toHaveBeenCalledTimes(1);
    expect(onPickAgent).toHaveBeenCalledWith(AGENT_B);
    expect(onLaunchSelected).not.toHaveBeenCalled();
  });

  test('"Configure agents" opens the settings tab', async () => {
    const user = userEvent.setup();
    const { onOpenSettings } = renderButton();

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Configure agents' }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test('marks the selected agent / CLI / terminal row current via aria-current', async () => {
    const user = userEvent.setup();
    renderButton({ selected: { kind: 'agent', agent: AGENT_A } });

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));

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

    await user.click(screen.getByRole('button', { name: 'Choose what a new session starts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Terminal' }));

    expect(onPickTerminal).toHaveBeenCalledTimes(1);
    expect(onPickCli).not.toHaveBeenCalled();
    expect(onLaunchSelected).not.toHaveBeenCalled();
  });
});
