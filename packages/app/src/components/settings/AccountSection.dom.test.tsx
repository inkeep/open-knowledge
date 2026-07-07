/**
 * RTL mount tests for the Settings → Account section. Behavior is
 * driven through the public prop interface — a stub AuthQueryTransport for
 * status/signout and a no-op AuthTransport for the AuthModal — and asserted on
 * user-visible output (rendered text, controls, surfaced errors). No internal
 * mocking; the catch paths are exercised with real failure-inducing transport
 * results.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getLastKnownSignedIn, setLastKnownSignedIn } from '@/lib/auth-state-cache';
import type { OkLocalOpAuthEvent, OkLocalOpAuthStatusResponse } from '@/lib/desktop-bridge-types';
import type { AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import type { AuthTransport } from '@/lib/transports/auth-transport';
import { AccountSection } from './AccountSection';

// Opening the AuthModal mounts a Radix focus-trap, which reaches for DOM
// globals `tests/dom/jsdom-preload.ts` does not expose. Hoist the needed
// shims locally — same pattern as `SettingsDialogShell.dom.test.tsx`.
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
// Tier A: the credential is delegated from the gh CLI, so OpenKnowledge holds
// no token of its own to disconnect.
const CONNECTED_GH_CLI: OkLocalOpAuthStatusResponse = {
  authenticated: true,
  host: 'github.com',
  login: 'octocat',
  tier: 'A',
};
// Older CLIs resolve a connection without emitting a tier; this still uses the
// standard OK-token Disconnect model.
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

// AuthModal auto-starts the device flow on mount; this stub keeps it pending so
// the modal renders without touching the network in jsdom.
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
  // The signed-in cache is module-level (shared with the Clone dialog), so reset
  // it around every test to keep one test's resolved status from leaking paint
  // state into the next.
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
    // Seed a known signed-in state. An unreachable check is not a confirmed
    // "not connected", so the catch must leave the shared cache untouched —
    // the Clone dialog reads this same cache for its flash-free first paint,
    // and flipping it to false here would wrongly revert that surface.
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

    // Pins that the retry button is wired to loadStatus — not just rendered.
    // An inert button would leave the user stuck in the error state.
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
    // The Clone dialog reads this cache on its next open; a FAILED disconnect
    // must leave it `true` so the other surface isn't wrongly reverted.
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
    // Two clicks in one commit: `disabled` only applies after the re-render, so
    // this exercises the synchronous re-entry guard rather than the disabled attr.
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

    // The Clone dialog reads this on its next open; false reverts it to the
    // plain URL input without a relaunch.
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
    // The caveat is the Disconnect button's accessible description, so a screen
    // reader surfaces it at the moment the user is deciding to disconnect.
    expect(disconnect.getAttribute('aria-describedby')).toBe(caveat.id);
  });

  test('an older CLI without a tier uses the standard Disconnect model', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED_NO_TIER }));

    expect(await screen.findByTestId('settings-account-disconnect')).toBeDefined();
    expect(screen.getByTestId('settings-account-disconnect-caveat')).toBeDefined();
    expect(screen.queryByTestId('settings-account-gh-cli')).toBeNull();
  });
});
