/**
 * The standalone terminal window must establish its own ConfigProvider: the
 * terminal-consent hooks under TerminalGate (`useTerminalConsentState` /
 * `useTerminalEnabledWriter` → `useConfigContext`) read the project-local
 * ConfigBinding, and this window has no editor/document tree to inherit the
 * provider from. Without it `useConfigContext` throws "must be used within
 * <ConfigProvider />", blanking the whole React root and leaving the window empty.
 *
 * Unlike the sibling behavioral test, TerminalGate is stubbed with a component
 * that ACTUALLY consumes `useConfigContext` — the same context the real consent
 * hooks read — so the test exercises the missing-provider crash. With the
 * provider wrapping removed, this render throws; with it, the child mounts.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConfigContext } from '@/lib/config-provider';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

// The New split-button calls react-query's useQuery; stub it so this test needs
// no QueryClientProvider.
vi.doMock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

// Stand in for the real TerminalGate: read the same context the terminal-consent
// hooks read. Throws (and blanks the root) if no ConfigProvider is above it.
vi.doMock('./TerminalGate', () => ({
  TerminalGate: () => {
    const { projectLocalSynced } = useConfigContext();
    return (
      <span data-testid="config-consumer" data-synced={projectLocalSynced ? 'true' : 'false'} />
    );
  },
}));

// Capture what the report trigger is told about this window rather than mounting
// the real dialog host: `systemWide` is the only thing this root decides for it,
// and it is what tells the reporter whether there are project logs to collect.
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
  });

  test('provides ConfigProvider context to its terminal subtree (project-less / empty collabUrl)', () => {
    // Empty collabUrl is the project-less terminal window. The consent hooks
    // must fail-open: the context resolves (no throw) with an unsynced binding.
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
    // The branch the sibling assertions never reached: with a collabUrl there
    // ARE project logs to collect, so a report filed from this window must not
    // claim to be system-wide or it collects the wrong thing.
    render(
      <TooltipProvider>
        <TerminalWindowApp bridge={bridgeWithCollabUrl('ws://localhost:5200/collab')} />
      </TooltipProvider>,
    );
    expect(reportTriggerProps.at(-1)?.systemWide).toBe(false);
  });
});
