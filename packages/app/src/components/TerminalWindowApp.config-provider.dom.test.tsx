import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConfigContext } from '@/lib/config-provider';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { TRANSITION_ATTRIBUTE, TRANSITION_STYLE_ID } from '@/lib/theme-color-transitions';

vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.doMock('./TerminalGate', () => ({
  TerminalGate: () => {
    const { projectLocalSynced } = useConfigContext();
    return (
      <span data-testid="config-consumer" data-synced={projectLocalSynced ? 'true' : 'false'} />
    );
  },
}));

const reportTriggerProps: { systemWide?: boolean }[] = [];
vi.doMock('./ReportBugMenuTrigger', () => ({
  ReportBugMenuTrigger: (props: { systemWide?: boolean }) => {
    reportTriggerProps.push(props);
    return null;
  },
}));

const { TerminalWindowApp } = await import('./TerminalWindowApp');

function bridgeWithCollabUrl(collabUrl: string): OkDesktopBridge {
  return {
    config: { mode: 'terminal', collabUrl },
    onMenuAction: () => () => {},
    editor: { notifyViewMenuStateChanged: () => {} },
    terminal: { create: async () => ({ ok: true, ptyId: 'pty-1' }), kill: async () => {} },
  } as unknown as OkDesktopBridge;
}

describe('TerminalWindowApp ConfigProvider wiring', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute(TRANSITION_ATTRIBUTE);
    document.getElementById(TRANSITION_STYLE_ID)?.remove();
  });

  test('arms theme colors through its provider in a project-less window', async () => {
    const registerProperty = vi.fn();
    vi.stubGlobal('CSS', { registerProperty });
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridgeWithCollabUrl('')} />
      </TooltipProvider>,
    );
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(registerProperty).toHaveBeenCalled();
    expect(document.documentElement.hasAttribute(TRANSITION_ATTRIBUTE)).toBe(true);
  });

  test('provides ConfigProvider context to its terminal subtree (project-less / empty collabUrl)', () => {
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridgeWithCollabUrl('')} />
      </TooltipProvider>,
    );
    const consumer = screen.getByTestId('config-consumer');
    expect(consumer).toBeTruthy();
    expect(consumer.getAttribute('data-synced')).toBe('false');
  });

  test('provides ConfigProvider context for a project-bound terminal window', () => {
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridgeWithCollabUrl('ws://localhost:5200/collab')} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('config-consumer')).toBeTruthy();
  });

  test('a project-less terminal window reports system-wide', () => {
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridgeWithCollabUrl('')} />
      </TooltipProvider>,
    );
    expect(reportTriggerProps.at(-1)?.systemWide).toBe(true);
  });

  test('a project-bound terminal window reports scoped to that project', () => {
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridgeWithCollabUrl('ws://localhost:5200/collab')} />
      </TooltipProvider>,
    );
    expect(reportTriggerProps.at(-1)?.systemWide).toBe(false);
  });
});
