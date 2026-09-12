import {
  AGENT_REGISTRY,
  type ApplyIntent,
  type ApplyReport,
  type HostSnapshot,
  satisfierId,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
} from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  type ApplyAgentConnectionsResult,
  applyAgentConnectionIntents,
} from '@/lib/agent-connections';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { terminalAgentSnapshot } from './terminal-agent-connections.test-helper';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ i18n: { locale: 'en' }, t: renderLinguiTemplate }),
}));

const { TerminalAgentConnectionBanner } = await import('./TerminalAgentConnectionBanner');

function result(
  snapshot: HostSnapshot | null,
  ok = true,
  actions: ApplyReport['actions'] = [],
): ApplyAgentConnectionsResult {
  return { ok, snapshot, report: { actions, conflicts: [], withheld: [] } };
}

const claudeMcpInstall: ApplyReport['actions'][number] = {
  satisfierId: satisfierId({
    agent: 'claude',
    piece: 'mcp',
    scope: 'project',
    kind: 'config-entry',
  }),
  agentId: 'claude',
  piece: 'mcp',
  scope: 'project',
  kind: 'config-entry',
  desired: 'present',
  action: 'written',
};

function renderBanner(
  props: Omit<Parameters<typeof TerminalAgentConnectionBanner>[0], 'onRestart'>,
) {
  return render(
    <TooltipProvider>
      <TerminalAgentConnectionBanner {...props} onRestart={vi.fn()} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TerminalAgentConnectionBanner', () => {
  test.each(TERMINAL_CLI_IDS)(
    '%s opens its Settings setup dialog without dismissing the banner',
    async (cli) => {
      const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
      renderBanner({ cli, applyConnections });

      expect(
        await screen.findByText(
          `${TERMINAL_CLIS[cli].displayName} is installed, but OpenKnowledge tools aren't connected to it yet.`,
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Connect tools' }));
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).toContain('Choose what OpenKnowledge sets up for');
      expect(dialog.textContent).toContain(TERMINAL_CLIS[cli].displayName);
      expect(screen.queryByText('Welcome to OpenKnowledge')).toBeNull();
      expect(applyConnections).toHaveBeenCalledTimes(1);
      expect(applyConnections).toHaveBeenCalledWith([]);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Connect tools' })).toBeTruthy();
      expect(screen.queryByTestId('terminal-restart-banner')).toBeNull();
    },
  );

  test.each(TERMINAL_CLI_IDS)(
    '%s needs no warning when MCP is connected and skills are missing',
    async (cli) => {
      const applyConnections = vi.fn(async () => result(terminalAgentSnapshot([cli])));
      await act(async () => {
        renderBanner({ cli, applyConnections });
      });
      expect(applyConnections).toHaveBeenCalledWith([]);
      expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
      expect(screen.queryByTestId('terminal-restart-banner')).toBeNull();
    },
  );

  test('successful setup replaces the warning with a dismissible restart notice', async () => {
    const applyConnections = vi.fn(async (intents: readonly ApplyIntent[]) =>
      result(
        terminalAgentSnapshot(intents.length === 0 ? [] : ['claude']),
        true,
        intents.length === 0 ? [] : [claudeMcpInstall],
      ),
    );
    renderBanner({ cli: 'claude', applyConnections });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect tools' }));
    expect(screen.getByText(/terminal and desktop rows/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    expect(screen.getByTestId('terminal-restart-banner').textContent).toContain(
      'Restart this terminal session to use the newly installed OpenKnowledge tools.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('terminal-restart-banner')).toBeNull();
    expect(applyConnections.mock.calls[1]?.[0].length).toBeGreaterThan(0);
    const claudeIds = new Set(AGENT_REGISTRY.claude.satisfiers.map((satisfier) => satisfier.id));
    for (const intent of applyConnections.mock.calls[1]?.[0] ?? []) {
      expect(claudeIds.has(intent.satisfierId)).toBe(true);
      expect(intent.desired).toBe('present');
    }
  });

  test.each([false, true])('a failed initial check offers retry (throws: %s)', async (throws) => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    if (throws) applyConnections.mockRejectedValueOnce(new Error('offline'));
    else applyConnections.mockResolvedValueOnce(result(null, false));
    renderBanner({ cli: 'claude', applyConnections });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Connect tools' });
    expect(screen.queryByTestId('terminal-connection-check-failed-banner')).toBeNull();
    expect(applyConnections).toHaveBeenCalledTimes(2);
  });

  test('a persistent failed check keeps Retry available until it succeeds', async () => {
    const applyConnections = vi
      .fn(async () => result(terminalAgentSnapshot()))
      .mockResolvedValueOnce(result(null, false))
      .mockResolvedValueOnce(result(null, false));
    renderBanner({ cli: 'claude', applyConnections });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(applyConnections).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect tools' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Connect tools' });
    expect(screen.queryByTestId('terminal-connection-check-failed-banner')).toBeNull();
    expect(applyConnections).toHaveBeenCalledTimes(3);
  });

  test('a skill-only install prioritizes restart and restores keyboard focus', async () => {
    const skill = AGENT_REGISTRY.claude.satisfiers.find(
      (entry) => entry.piece === 'skill' && entry.scope === 'project',
    );
    if (skill === undefined) throw new Error('Claude project skill is missing');
    const applyConnections = vi.fn(async (intents: readonly ApplyIntent[]) =>
      result(
        terminalAgentSnapshot(),
        true,
        intents.length === 0
          ? []
          : [
              {
                ...claudeMcpInstall,
                satisfierId: skill.id,
                piece: 'skill',
                kind: skill.kind,
              },
            ],
      ),
    );
    renderBanner({ cli: 'claude', applyConnections });
    const connect = await screen.findByRole('button', { name: 'Connect tools' });
    connect.focus();
    fireEvent.click(connect);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Project MCP server' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Global MCP server' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'OpenKnowledge discovery skill' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    expect(applyConnections.mock.calls[1]?.[0]).toEqual([
      { satisfierId: skill.id, desired: 'present' },
    ]);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restart terminal' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('terminal-restart-banner')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect tools' })).toBeTruthy();
  });

  test('an install through the shared Settings API refreshes sibling terminals for that agent', async () => {
    let installed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { intents } = JSON.parse(String(init.body)) as { intents: ApplyIntent[] };
        const applying = intents.length > 0;
        if (applying) installed = true;
        return new Response(
          JSON.stringify({
            actions: applying ? [claudeMcpInstall] : [],
            conflicts: [],
            withheld: [],
            snapshot: terminalAgentSnapshot(installed ? ['claude', 'copilot'] : []),
          }),
        );
      }),
    );
    const first = renderBanner({ cli: 'claude' });
    renderBanner({ cli: 'claude' });
    renderBanner({ cli: 'codex' });
    renderBanner({ cli: 'copilot' });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Connect tools' })).toHaveLength(4),
    );
    await act(async () => {
      await applyAgentConnectionIntents([
        { satisfierId: claudeMcpInstall.satisfierId, desired: 'present' },
      ]);
    });
    expect(screen.getAllByRole('button', { name: 'Restart terminal' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Connect tools' })).toHaveLength(1);
    expect(screen.getByTestId('terminal-readiness-banner').textContent).toContain('Codex');
    first.unmount();
    await act(async () => {
      renderBanner({ cli: 'claude' });
    });
    expect(screen.getAllByRole('button', { name: 'Restart terminal' })).toHaveLength(2);
  });

  test('a late mount snapshot cannot replace a newer install result', async () => {
    let finishRead: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { intents } = JSON.parse(String(init.body)) as { intents: ApplyIntent[] };
        if (intents.length === 0)
          return new Promise<Response>((resolve) => {
            finishRead = resolve;
          });
        return new Response(
          JSON.stringify({
            actions: [claudeMcpInstall],
            conflicts: [],
            withheld: [],
            snapshot: terminalAgentSnapshot(['claude']),
          }),
        );
      }),
    );
    renderBanner({ cli: 'claude' });
    await act(async () => {
      await applyAgentConnectionIntents([
        { satisfierId: claudeMcpInstall.satisfierId, desired: 'present' },
      ]);
    });
    await act(async () => {
      finishRead?.(
        new Response(
          JSON.stringify({
            actions: [],
            conflicts: [],
            withheld: [],
            snapshot: terminalAgentSnapshot(),
          }),
        ),
      );
    });
    expect(screen.getByRole('button', { name: 'Restart terminal' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
  });

  test('a failed save keeps the dialog and warning available', async () => {
    const applyConnections = vi.fn(async (intents: readonly ApplyIntent[]) =>
      result(terminalAgentSnapshot(), intents.length === 0),
    );
    renderBanner({ cli: 'codex', applyConnections });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(applyConnections).toHaveBeenCalledTimes(2));
    await screen.findByRole('alert');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('terminal-readiness-banner')).toBeTruthy();
    expect(screen.queryByTestId('terminal-restart-banner')).toBeNull();
  });

  test('partial setup still asks for a restart when it installed tools', async () => {
    const applyConnections = vi.fn(async (intents: readonly ApplyIntent[]) =>
      result(
        terminalAgentSnapshot(intents.length === 0 ? [] : ['claude']),
        intents.length === 0,
        intents.length === 0 ? [] : [claudeMcpInstall],
      ),
    );
    renderBanner({ cli: 'claude', applyConnections });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('terminal-restart-banner')).toBeTruthy();
  });

  test('a successful response with MCP still missing leaves the warning', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    renderBanner({ cli: 'claude', applyConnections });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Connect tools' })).toBeTruthy();
    expect(screen.queryByTestId('terminal-restart-banner')).toBeNull();
  });

  test('dismissal lasts for the session and a fresh session checks again', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const first = renderBanner({ cli: 'pi', applyConnections });
    await screen.findByRole('button', { name: 'Connect tools' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    first.rerender(
      <TooltipProvider>
        <TerminalAgentConnectionBanner
          cli="pi"
          applyConnections={applyConnections}
          onRestart={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    first.unmount();
    renderBanner({ cli: 'pi', applyConnections });
    await screen.findByRole('button', { name: 'Connect tools' });
    expect(applyConnections).toHaveBeenCalledTimes(2);
  });

  test('an unverified snapshot offers retry without claiming the agent is disconnected', async () => {
    const snapshot: HostSnapshot = {
      ...terminalAgentSnapshot(),
      probes: { env: 'desktop', satisfiers: {} },
    };
    await act(async () => {
      renderBanner({ cli: 'claude', applyConnections: async () => result(snapshot) });
    });
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('an external install can recover a failed check to show the setup warning', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('offline', { status: 503 }))
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({
                actions: [],
                conflicts: [],
                withheld: [],
                snapshot: terminalAgentSnapshot(),
              }),
            ),
        ),
    );
    renderBanner({ cli: 'claude' });
    await screen.findByRole('button', { name: 'Retry' });
    await act(async () => {
      await applyAgentConnectionIntents([
        { satisfierId: AGENT_REGISTRY.codex.satisfiers[0].id, desired: 'present' },
      ]);
    });
    expect(screen.getByRole('button', { name: 'Connect tools' })).toBeTruthy();
    expect(screen.queryByTestId('terminal-connection-check-failed-banner')).toBeNull();
  });

  test('an unknown agent receipt does not prevent known agents receiving restart notices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { intents } = JSON.parse(String(init.body)) as { intents: ApplyIntent[] };
        return new Response(
          JSON.stringify({
            actions:
              intents.length === 0
                ? []
                : [
                    {
                      ...claudeMcpInstall,
                      agentId: 'future-agent',
                      satisfierId: 'future-agent/mcp/project/config-entry',
                    },
                    claudeMcpInstall,
                  ],
            conflicts: [],
            withheld: [],
            snapshot: terminalAgentSnapshot(intents.length === 0 ? [] : ['claude', 'copilot']),
          }),
        );
      }),
    );
    renderBanner({ cli: 'claude' });
    renderBanner({ cli: 'copilot' });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Connect tools' })).toHaveLength(2),
    );
    await act(async () => {
      const installed = await applyAgentConnectionIntents([
        { satisfierId: claudeMcpInstall.satisfierId, desired: 'present' },
      ]);
      expect(installed.ok).toBe(true);
    });
    expect(screen.getAllByRole('button', { name: 'Restart terminal' })).toHaveLength(2);
  });

  test('an unavailable connection manager does not offer an unusable setup action', async () => {
    await act(async () => {
      renderBanner({
        cli: 'claude',
        applyConnections: async () => ({
          ...result(terminalAgentSnapshot(), false),
          unavailable: true,
        }),
      });
    });
    expect(screen.queryByTestId('terminal-readiness-banner')).toBeNull();
  });
});
