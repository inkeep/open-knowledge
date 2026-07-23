import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { useUpdateChannel } from './use-update-channel';

function setBridge(bridge: unknown) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

function makeBridge({
  channel = 'beta',
  queryDelayMs = 0,
}: {
  channel?: 'beta' | 'latest';
  queryDelayMs?: number;
} = {}) {
  const queryCalls: string[] = [];
  const onChannelChangedCalls: string[] = [];
  const bridge = {
    state: {
      query: () => {
        queryCalls.push('query');
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                channel,
                schemaIncompatibility: null,
              }),
            queryDelayMs,
          );
        });
      },
      resetIncompatible: () => Promise.resolve(),
      onChannelChanged: () => {
        onChannelChangedCalls.push('subscribe');
        return () => {};
      },
    },
  } as unknown as OkDesktopBridge & {
    state: OkDesktopBridge['state'] & { onChannelChanged: () => () => void };
  };

  return { bridge, queryCalls, onChannelChangedCalls };
}

function ChannelProbe() {
  const { channel } = useUpdateChannel();
  return <output data-testid="update-channel">{channel ?? 'null'}</output>;
}

describe('useUpdateChannel runtime behavior', () => {
  afterEach(() => {
    cleanup();
    setBridge(undefined);
  });

  test('exports the hook', () => {
    expect(typeof useUpdateChannel).toBe('function');
  });

  test('returns null and does not query when the desktop bridge is absent', async () => {
    setBridge(undefined);

    render(<ChannelProbe />);

    expect(screen.getByTestId('update-channel').textContent).toBe('null');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('update-channel').textContent).toBe('null');
  });

  test('queries the desktop bridge once and updates the channel when it resolves', async () => {
    const { bridge, queryCalls } = makeBridge({ channel: 'beta' });
    setBridge(bridge);

    render(<ChannelProbe />);

    expect(screen.getByTestId('update-channel').textContent).toBe('null');
    await waitFor(() => {
      expect(screen.getByTestId('update-channel').textContent).toBe('beta');
    });
    expect(queryCalls).toEqual(['query']);
  });

  test('does not subscribe to runtime channel changes', async () => {
    const { bridge, onChannelChangedCalls } = makeBridge({ channel: 'latest' });
    setBridge(bridge);

    render(<ChannelProbe />);

    await waitFor(() => {
      expect(screen.getByTestId('update-channel').textContent).toBe('latest');
    });
    expect(onChannelChangedCalls).toEqual([]);
  });
});
