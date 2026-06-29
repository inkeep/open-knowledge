import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getLastKnownSignedIn, setLastKnownSignedIn } from '@/lib/auth-state-cache';
import type { OkLocalOpAuthEvent, OkLocalOpAuthStatusResponse } from '@/lib/desktop-bridge-types';
import type { AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import type { AuthTransport } from '@/lib/transports/auth-transport';
import { AccountSection } from './AccountSection';

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
};
const CONNECTED_GH_CLI: OkLocalOpAuthStatusResponse = {
  authenticated: true,
  host: 'github.com',
  login: 'octocat',
  tier: 'A',
};
const CONNECTED_NO_TIER: OkLocalOpAuthStatusResponse = {
  authenticated: true,
  host: 'github.com',
  login: 'octocat',
};
const NOT_CONNECTED: OkLocalOpAuthStatusResponse = { authenticated: false, host: 'github.com' };

function makeQueryTransport(parts: {
  status: AuthQueryTransport['status'];
  signout?: AuthQueryTransport['signout'];
}): AuthQueryTransport {
  return {
    status: parts.status,
    repos: async () => ({ ok: true, host: 'github.com', repos: [] }),
    signout: parts.signout ?? (async () => ({ ok: true })),
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

function renderSection(authQueryTransport: AuthQueryTransport) {
  return render(
    <TooltipProvider>
      <AccountSection authQueryTransport={authQueryTransport} authTransport={noopAuthTransport} />
    </TooltipProvider>,
  );
}

describe('AccountSection', () => {
  beforeEach(() => setLastKnownSignedIn(null));
  afterEach(() => {
    cleanup();
    setLastKnownSignedIn(null);
  });

  test('shows "Connected as @<login>" and a Disconnect control when authenticated', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    expect(await screen.findByText('Connected as @octocat')).toBeDefined();
    expect(screen.getByTestId('settings-account-disconnect')).toBeDefined();
    expect(screen.queryByTestId('settings-account-connect')).toBeNull();
  });

  test('shows "Not connected" and a Connect GitHub control when unauthenticated', async () => {
    renderSection(makeQueryTransport({ status: async () => NOT_CONNECTED }));

    expect(await screen.findByText('Not connected')).toBeDefined();
    const connect = screen.getByRole('button', { name: 'Connect GitHub' });
    expect(connect).toBeDefined();
    expect(screen.queryByTestId('settings-account-disconnect')).toBeNull();
  });

  test('clicking Connect GitHub opens the AuthModal in connect mode (not reauth)', async () => {
    const user = userEvent.setup();
    renderSection(makeQueryTransport({ status: async () => NOT_CONNECTED }));

    await user.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Connect GitHub')).toBeDefined();
    expect(screen.queryByText('Re-authenticate with GitHub')).toBeNull();
  });

  test('surfaces a retry affordance when the status check cannot be reached', async () => {
    setLastKnownSignedIn(true);
    renderSection(
      makeQueryTransport({
        status: async () => {
          throw new Error('network down');
        },
      }),
    );

    expect(await screen.findByText("We couldn't check your GitHub connection.")).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
    expect(getLastKnownSignedIn()).toBe(true);
  });

  test('clicking Try again re-runs the status check and repaints', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderSection(
      makeQueryTransport({
        status: async () => {
          calls += 1;
          if (calls === 1) throw new Error('transient failure');
          return CONNECTED;
        },
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Connected as @octocat')).toBeDefined();
  });

  test('Disconnect clears the token and repaints to "Not connected"', async () => {
    const user = userEvent.setup();
    let signedOut = false;
    renderSection(
      makeQueryTransport({
        status: async () => (signedOut ? NOT_CONNECTED : CONNECTED),
        signout: async () => {
          signedOut = true;
          return { ok: true };
        },
      }),
    );

    await user.click(await screen.findByTestId('settings-account-disconnect'));

    expect(await screen.findByText('Not connected')).toBeDefined();
    expect(screen.queryByText('Connected as @octocat')).toBeNull();
  });

  test('a failed disconnect surfaces an error and stays Connected', async () => {
    const user = userEvent.setup();
    renderSection(
      makeQueryTransport({
        status: async () => CONNECTED,
        signout: async () => ({ ok: false, error: 'Auth signout failed.' }),
      }),
    );

    await user.click(await screen.findByTestId('settings-account-disconnect'));

    expect(await screen.findByText('Auth signout failed.')).toBeDefined();
    expect(screen.getByText('Connected as @octocat')).toBeDefined();
    expect(getLastKnownSignedIn()).toBe(true);
  });

  test('a thrown signout surfaces the generic error and stays Connected', async () => {
    const user = userEvent.setup();
    renderSection(
      makeQueryTransport({
        status: async () => CONNECTED,
        signout: async () => {
          throw new Error('relay spawn failed');
        },
      }),
    );

    await user.click(await screen.findByTestId('settings-account-disconnect'));

    expect(await screen.findByText("Couldn't disconnect — please try again.")).toBeDefined();
    expect(screen.getByText('Connected as @octocat')).toBeDefined();
  });

  test('double-clicking Disconnect spawns only one relay signout', async () => {
    let signoutCalls = 0;
    let releaseSignout: (() => void) | undefined;
    const signoutGate = new Promise<void>((resolve) => {
      releaseSignout = resolve;
    });
    let signedOut = false;
    renderSection(
      makeQueryTransport({
        status: async () => (signedOut ? NOT_CONNECTED : CONNECTED),
        signout: async () => {
          signoutCalls += 1;
          await signoutGate;
          signedOut = true;
          return { ok: true };
        },
      }),
    );

    const button = await screen.findByTestId('settings-account-disconnect');
    act(() => {
      button.click();
      button.click();
    });

    expect(signoutCalls).toBe(1);

    releaseSignout?.();
    expect(await screen.findByText('Not connected')).toBeDefined();
  });

  test('a successful disconnect clears the shared signed-in cache', async () => {
    const user = userEvent.setup();
    let signedOut = false;
    renderSection(
      makeQueryTransport({
        status: async () => (signedOut ? NOT_CONNECTED : CONNECTED),
        signout: async () => {
          signedOut = true;
          return { ok: true };
        },
      }),
    );

    expect(await screen.findByText('Connected as @octocat')).toBeDefined();
    expect(getLastKnownSignedIn()).toBe(true);

    await user.click(screen.getByTestId('settings-account-disconnect'));
    await screen.findByText('Not connected');

    expect(getLastKnownSignedIn()).toBe(false);
  });

  test('gh-CLI tier shows honest copy and no inert Disconnect control', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED_GH_CLI }));

    const ghRow = await screen.findByTestId('settings-account-gh-cli');
    expect(within(ghRow).getByText('Connected as @octocat')).toBeDefined();
    expect(ghRow.textContent).toContain('no separate OpenKnowledge credential to disconnect');
    expect(screen.queryByTestId('settings-account-disconnect')).toBeNull();
  });

  test('an OK-token connection shows the git-credential caveat described by the Disconnect button', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    const disconnect = await screen.findByTestId('settings-account-disconnect');
    const caveat = screen.getByTestId('settings-account-disconnect-caveat');
    expect(caveat.textContent).toContain("git's own saved credentials");
    expect(disconnect.getAttribute('aria-describedby')).toBe(caveat.id);
  });

  test('an older CLI without a tier uses the standard Disconnect model', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED_NO_TIER }));

    expect(await screen.findByTestId('settings-account-disconnect')).toBeDefined();
    expect(screen.getByTestId('settings-account-disconnect-caveat')).toBeDefined();
    expect(screen.queryByTestId('settings-account-gh-cli')).toBeNull();
  });
});
