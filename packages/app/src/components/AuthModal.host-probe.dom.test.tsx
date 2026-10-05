import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkLocalOpAuthEvent } from '@/lib/desktop-bridge-types';
import type { AuthQueryStatus, AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import type { AuthTransport } from '@/lib/transports/auth-transport';

const toastErrorCalls: string[] = [];

vi.doMock('sonner', () => ({
  toast: {
    error: (msg: string) => {
      toastErrorCalls.push(msg);
    },
    info: () => {},
    success: () => {},
    warn: () => {},
  },
}));

const { AuthModal } = await import('./AuthModal');

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const noopAuthTransport: AuthTransport = {
  start: () => ({
    events: {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<OkLocalOpAuthEvent>>(() => {}) };
      },
    },
    cancel() {},
  }),
};

function renderModal(status: () => Promise<AuthQueryStatus>) {
  const onOpenChange = vi.fn();
  const queryTransport: AuthQueryTransport = {
    status,
    repos: async () => ({ ok: true, host: 'github.com', repos: [] }),
    signout: async () => ({ ok: true }),
  };
  render(
    <AuthModal
      open
      onOpenChange={onOpenChange}
      transport={noopAuthTransport}
      queryTransport={queryTransport}
    />,
  );
  return onOpenChange;
}

describe('AuthModal host probe refusal', () => {
  beforeEach(() => {
    toastErrorCalls.length = 0;
  });
  afterEach(cleanup);

  test('an origin refusal closes the modal with the server message instead of a sign-in step', async () => {
    const onOpenChange = renderModal(async () => ({
      authenticated: false,
      host: 'gitlab.example.com',
      error: 'GitHub sign-in is unavailable for this host.',
      unsupportedOrigin: { host: 'gitlab.example.com' },
    }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastErrorCalls).toEqual(['GitHub sign-in is unavailable for this host.']);
    expect(screen.queryByText('Starting sign-in flow')).toBeNull();
    expect(screen.queryByText('Create a token on gitlab.example.com')).toBeNull();
  });

  test('a probe that throws falls through to the sign-in flow instead of closing', async () => {
    const onOpenChange = renderModal(async () => {
      throw new Error('offline');
    });

    expect(await screen.findByText('Starting sign-in flow')).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toastErrorCalls).toEqual([]);
  });

  test('an ordinary signed-out probe still reaches the github.com device flow', async () => {
    const onOpenChange = renderModal(async () => ({
      authenticated: false,
      host: 'github.com',
      error: 'not logged in',
    }));

    expect(await screen.findByText('Starting sign-in flow')).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toastErrorCalls).toEqual([]);
  });

  test('an enterprise host probe still reaches the token step', async () => {
    const onOpenChange = renderModal(async () => ({
      authenticated: false,
      host: 'ghe.example.com',
    }));

    expect(await screen.findByText('Connect to GitHub Enterprise Server')).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toastErrorCalls).toEqual([]);
  });

  test('a probe that outlasts the timeout falls through to sign-in and its late answer is ignored', async () => {
    vi.useFakeTimers();
    try {
      let answer: ((status: AuthQueryStatus) => void) | undefined;
      const onOpenChange = renderModal(
        () =>
          new Promise<AuthQueryStatus>((resolve) => {
            answer = resolve;
          }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(screen.queryByText('Starting sign-in flow')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByText('Starting sign-in flow')).toBeDefined();

      await act(async () => {
        answer?.({
          authenticated: false,
          host: 'gitlab.example.com',
          error: 'GitHub sign-in is unavailable for this host.',
          unsupportedOrigin: { host: 'gitlab.example.com' },
        });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('Starting sign-in flow')).toBeDefined();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(toastErrorCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an enterprise answer arriving after the timeout does not switch to the token step', async () => {
    vi.useFakeTimers();
    try {
      let answer: ((status: AuthQueryStatus) => void) | undefined;
      renderModal(
        () =>
          new Promise<AuthQueryStatus>((resolve) => {
            answer = resolve;
          }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await act(async () => {
        answer?.({ authenticated: false, host: 'ghe.example.com' });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('Starting sign-in flow')).toBeDefined();
      expect(screen.queryByText('Connect to GitHub Enterprise Server')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
