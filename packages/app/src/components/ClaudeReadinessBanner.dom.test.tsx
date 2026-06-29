
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClaudeReadiness, OkDesktopBridge } from '@/lib/desktop-bridge-types';

const toastErrors: string[] = [];
mock.module('sonner', () => ({
  toast: { error: (message: string) => toastErrors.push(message) },
}));

const { ClaudeReadinessBanner } = await import('./ClaudeReadinessBanner');

function makeBridge(rewireResult: ClaudeReadiness = { claude: 'present', mcp: 'wired' }) {
  const openExternal = mock(async (_url: string) => {});
  const rewireClaudeMcp = mock(async () => rewireResult);
  const bridge = {
    shell: { openExternal },
    terminal: { rewireClaudeMcp },
  } as unknown as OkDesktopBridge;
  return { bridge, openExternal, rewireClaudeMcp };
}

beforeEach(() => {
  toastErrors.length = 0;
});
afterEach(() => cleanup());

describe('ClaudeReadinessBanner', () => {
  test('not-found: offers a help affordance that opens the Claude Code docs', () => {
    const { bridge, openExternal, rewireClaudeMcp } = makeBridge();
    render(
      <ClaudeReadinessBanner
        readiness={{ claude: 'not-found', mcp: 'needs-rewire' }}
        bridge={bridge}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByText(/isn't installed or on your PATH/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get Claude Code' }));
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0]?.[0]).toContain('claude-code');
    expect(rewireClaudeMcp).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Connect tools' })).toBeNull();
  });

  test('present + needs-rewire: offers a re-wire affordance and dismisses on success', async () => {
    const onDismiss = mock(() => {});
    const { bridge, rewireClaudeMcp, openExternal } = makeBridge();
    render(
      <ClaudeReadinessBanner
        readiness={{ claude: 'present', mcp: 'needs-rewire' }}
        bridge={bridge}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText(/aren't connected to it yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect tools' }));
    expect(rewireClaudeMcp).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('present + needs-rewire: a rewire that reports an error surfaces a toast and keeps the banner', async () => {
    const onDismiss = mock(() => {});
    const { bridge } = makeBridge({
      claude: 'present',
      mcp: 'needs-rewire',
      rewireError: 'consent dialog failed to arm',
    });
    render(
      <ClaudeReadinessBanner
        readiness={{ claude: 'present', mcp: 'needs-rewire' }}
        bridge={bridge}
        onDismiss={onDismiss}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect tools' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(toastErrors.length).toBe(1));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('present + wired: renders nothing', () => {
    const { bridge } = makeBridge();
    const { container } = render(
      <ClaudeReadinessBanner
        readiness={{ claude: 'present', mcp: 'wired' }}
        bridge={bridge}
        onDismiss={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('unknown probe verdict renders nothing (no false "not installed")', () => {
    const { bridge } = makeBridge();
    const { container } = render(
      <ClaudeReadinessBanner
        readiness={{ claude: 'unknown', mcp: 'needs-rewire' }}
        bridge={bridge}
        onDismiss={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('exposes a status live region and an accessible dismiss control', () => {
    const onDismiss = mock(() => {});
    const { bridge } = makeBridge();
    render(
      <ClaudeReadinessBanner
        readiness={{ claude: 'not-found', mcp: 'needs-rewire' }}
        bridge={bridge}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole('status')).toBeTruthy();
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
