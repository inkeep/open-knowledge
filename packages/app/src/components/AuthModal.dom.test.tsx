import { afterEach, describe, expect, jest, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { OkLocalOpAuthEvent, OkLocalOpAuthStatusResponse } from '@/lib/desktop-bridge-types';
import type { AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import type { AuthTransport } from '@/lib/transports/auth-transport';
import { AuthModal } from './AuthModal';

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

const CONNECTED: OkLocalOpAuthStatusResponse = {
  authenticated: true,
  host: 'github.com',
  login: 'octocat',
  tier: 'B',
  name: 'Octo Cat',
  email: 'octo@github.com',
};
const NOT_CONNECTED: OkLocalOpAuthStatusResponse = { authenticated: false, host: 'github.com' };

function makeQueryTransport(status: OkLocalOpAuthStatusResponse): AuthQueryTransport {
  return {
    status: async () => status,
    repos: async () => ({ ok: true, host: 'github.com', repos: [] }),
    signout: async () => ({ ok: true }),
  };
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

function completingAuthTransport(result: {
  login: string;
  name?: string;
  email?: string;
}): AuthTransport {
  return {
    start: () => ({
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'complete',
            host: 'github.com',
            login: result.login,
            name: result.name,
            email: result.email,
          } satisfies OkLocalOpAuthEvent;
        },
      },
      cancel() {},
    }),
  };
}

function renderModal(props: {
  identityPrompt?: boolean;
  queryTransport: AuthQueryTransport;
  transport?: AuthTransport;
}) {
  return render(
    <AuthModal
      open
      onOpenChange={() => {}}
      identityPrompt={props.identityPrompt}
      transport={props.transport ?? noopAuthTransport}
      queryTransport={props.queryTransport}
    />,
  );
}

describe('AuthModal identityPrompt (set-identity) path', () => {
  afterEach(cleanup);

  test('signed-in user lands on the identity fields without the device flow', async () => {
    renderModal({ identityPrompt: true, queryTransport: makeQueryTransport(CONNECTED) });

    const name = await screen.findByLabelText('Name');
    const email = await screen.findByLabelText('Email');

    expect((name as HTMLInputElement).value).toBe('Octo Cat');
    expect((email as HTMLInputElement).value).toBe('octo@github.com');

    expect(screen.getByText('Set git identity')).toBeDefined();
    expect(screen.getByText('Connected as @octocat')).toBeDefined();
    expect(screen.queryByText('Starting sign-in flow')).toBeNull();
  });

  test('unauthenticated user falls back to the device flow', async () => {
    renderModal({ identityPrompt: true, queryTransport: makeQueryTransport(NOT_CONNECTED) });

    expect(await screen.findByText('Starting sign-in flow')).toBeDefined();
    expect(screen.getByText('Connect GitHub')).toBeDefined();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  test('device-flow fallback under identityPrompt still lands on the identity fields', async () => {
    renderModal({
      identityPrompt: true,
      queryTransport: makeQueryTransport(NOT_CONNECTED),
      transport: completingAuthTransport({
        login: 'octocat',
        name: 'Octo Cat',
        email: 'octo@github.com',
      }),
    });

    const name = await screen.findByLabelText('Name');
    expect((name as HTMLInputElement).value).toBe('Octo Cat');
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('octo@github.com');
    expect(screen.getByText('Connected as @octocat')).toBeDefined();
    expect(screen.getByText('Set git identity')).toBeDefined();
  });

  test('a hung status probe times out and falls back to the device flow', async () => {
    const hungQuery: AuthQueryTransport = {
      status: () => new Promise<never>(() => {}),
      repos: async () => ({ ok: true, host: 'github.com', repos: [] }),
    };

    jest.useFakeTimers();
    try {
      renderModal({ identityPrompt: true, queryTransport: hungQuery });

      expect(screen.getByText('Checking sign-in status')).toBeDefined();
      expect(screen.queryByText('Starting sign-in flow')).toBeNull();

      act(() => {
        jest.advanceTimersByTime(10_000);
      });

      expect(screen.getByText('Starting sign-in flow')).toBeDefined();
      expect(screen.getByText('Connect GitHub')).toBeDefined();
      expect(screen.queryByLabelText('Name')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('sign-in path (no identityPrompt) goes straight to the device flow', async () => {
    const throwingQuery: AuthQueryTransport = {
      status: async () => {
        throw new Error('status must not be called for the sign-in path');
      },
      repos: async () => ({ ok: false, error: 'unused' }),
    };

    renderModal({ identityPrompt: false, queryTransport: throwingQuery });

    expect(await screen.findByText('Starting sign-in flow')).toBeDefined();
    expect(screen.getByText('Connect GitHub')).toBeDefined();
  });
});
