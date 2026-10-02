import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { desktopEnabledKey, setAgentEnabled } from '@/lib/acp/enabled-agents';
import type { ApplyAgentConnectionsResult } from '@/lib/agent-connections';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { terminalAgentSnapshot } from '../terminal-agent-connections.test-helper';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ i18n: { locale: 'en' }, t: renderLinguiTemplate }),
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: null }),
}));

const openExternal = vi.fn(async () => ({ ok: true as const }));
const dispatchHandoff = vi.fn(async () => ({ ok: true as const }));
vi.doMock('@/lib/handoff/open-external', () => ({ openExternal }));
vi.doMock('@/lib/handoff/dispatch', () => ({ dispatchHandoff }));
vi.doMock('@/lib/handoff/telemetry', () => ({ recordHandoff: vi.fn(async () => undefined) }));

const { ExternalHandoffGateProvider } = await import('./ExternalHandoffGate');
const { OpenInAgentContextSubmenu } = await import('./OpenInAgentContextSubmenu');
const { useHandoffDispatch } = await import('./useHandoffDispatch');

const input = {
  docContext: { relativePath: 'notes/today.md' },
  docPath: '/project/notes/today.md',
  projectDir: '/project',
};

function states(codexInstalled: boolean): Record<HandoffTarget, InstallState> {
  return {
    'claude-code': { installed: false, lastChecked: 1 },
    'claude-cowork': { installed: false, lastChecked: 1 },
    codex: { installed: codexInstalled, lastChecked: 1 },
    cursor: { installed: false, lastChecked: 1 },
  };
}

function FileTreeMenu({ codexInstalled }: { codexInstalled: boolean }) {
  const [open, setOpen] = useState(true);
  const { dispatch } = useHandoffDispatch();
  return (
    <>
      <Button>File row</Button>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent forceMount>
          <OpenInAgentContextSubmenu
            input={input}
            installStates={states(codexInstalled)}
            isElectronHost
            dispatch={dispatch}
            onBeforeLaunch={() => setOpen(false)}
            restoreFocus={() => screen.getByRole('button', { name: 'File row' }).focus()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function renderFileTreeMenu(
  codexInstalled: boolean,
  applyConnections: () => Promise<ApplyAgentConnectionsResult>,
) {
  return render(
    <TooltipProvider>
      <ExternalHandoffGateProvider applyConnections={applyConnections}>
        <FileTreeMenu codexInstalled={codexInstalled} />
      </ExternalHandoffGateProvider>
    </TooltipProvider>,
  );
}

async function selectCodex() {
  await userEvent.hover(screen.getByRole('menuitem', { name: 'Open with AI' }));
  await waitFor(() => {
    expect(document.querySelector('[data-slot="dropdown-menu-sub-content"]')).toBeTruthy();
  });
  await userEvent.click(screen.getByRole('menuitem', { name: 'Open with AI ChatGPT Desktop' }));
}

describe('FileTree external handoff', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setAgentEnabled(desktopEnabledKey('codex'), undefined);
  });

  test('an explicitly enabled app that is absent opens its installer without showing setup', async () => {
    setAgentEnabled(desktopEnabledKey('codex'), true);
    const applyConnections = vi.fn(async () => ({
      ok: true,
      report: { actions: [], conflicts: [], withheld: [] },
      snapshot: terminalAgentSnapshot(),
    }));
    renderFileTreeMenu(false, applyConnections);

    await selectCodex();

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith('https://developers.openai.com/codex/app');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(applyConnections).not.toHaveBeenCalled();
    expect(dispatchHandoff).not.toHaveBeenCalled();
  });

  test('canceling setup after the live submenu closes returns focus to the file row', async () => {
    const applyConnections = vi.fn(async () => ({
      ok: true,
      report: { actions: [], conflicts: [], withheld: [] },
      snapshot: terminalAgentSnapshot(),
    }));
    renderFileTreeMenu(true, applyConnections);

    await selectCodex();
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'File row' }));
    expect(dispatchHandoff).not.toHaveBeenCalled();
  });
});
