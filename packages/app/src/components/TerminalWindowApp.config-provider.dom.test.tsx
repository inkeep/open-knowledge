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

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConfigContext } from '@/lib/config-provider';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

// Stand in for the real TerminalGate: read the same context the terminal-consent
// hooks read. Throws (and blanks the root) if no ConfigProvider is above it.
mock.module('./TerminalGate', () => ({
  TerminalGate: () => {
    const { projectLocalSynced } = useConfigContext();
    return (
      <span data-testid="config-consumer" data-synced={projectLocalSynced ? 'true' : 'false'} />
    );
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
});
