import { bindConfigDoc, type ConfigBinding } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getLastKnownSignedIn, setLastKnownSignedIn } from '@/lib/auth-state-cache';
import type { OkLocalOpAuthEvent, OkLocalOpAuthStatusResponse } from '@/lib/desktop-bridge-types';
import type { AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import type { AuthTransport } from '@/lib/transports/auth-transport';
import { AccountSection, hostFromRemoteLabel } from './AccountSection';

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

const bindings: ConfigBinding[] = [];

function bindUserConfig(): ConfigBinding {
  const listeners = new Set<() => void>();
  const binding = bindConfigDoc(
    {
      document: new Y.Doc(),
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
    },
    'user',
  );
  for (const listener of listeners) listener();
  bindings.push(binding);
  return binding;
}

afterEach(() => {
  for (const binding of bindings.splice(0)) binding.dispose();
});

function renderSection(
  authQueryTransport: AuthQueryTransport,
  authTransport: AuthTransport = noopAuthTransport,
) {
  return render(
    <TooltipProvider>
      <AccountSection
        authQueryTransport={authQueryTransport}
        authTransport={authTransport}
        userBinding={bindUserConfig()}
      />
    </TooltipProvider>,
  );
}

function makeAuthTransport(hostToken: NonNullable<AuthTransport['hostToken']>): AuthTransport {
  return { ...noopAuthTransport, hostToken };
}

describe('AccountSection', () => {
  beforeEach(() => setLastKnownSignedIn(null));
  afterEach(() => {
    cleanup();
    setLastKnownSignedIn(null);
    for (const binding of bindings.splice(0)) binding.dispose();
  });

  test('shows "Connected to <host> as @<login>" and a Disconnect control when authenticated', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    expect(await screen.findByText('Connected to github.com as @octocat')).toBeDefined();
    expect(screen.getByTestId('settings-account-disconnect')).toBeDefined();
    expect(screen.queryByTestId('settings-account-connect')).toBeNull();
  });

  test('shows "Not connected" and a Sign in control when unauthenticated', async () => {
    renderSection(makeQueryTransport({ status: async () => NOT_CONNECTED }));

    expect(await screen.findByText('Not connected')).toBeDefined();
    const connect = screen.getByRole('button', { name: 'Sign in' });
    expect(connect).toBeDefined();
    expect(screen.queryByTestId('settings-account-disconnect')).toBeNull();
  });

  test('an origin on a host that is not GitHub hides the GitHub sign-in box', async () => {
    setLastKnownSignedIn(true);
    const status = vi.fn(async () => ({
      authenticated: false as const,
      host: 'gitea.acme.test',
      error: 'GitHub sign-in is unavailable for this host.',
      unsupportedOrigin: { host: 'gitea.acme.test' },
    }));
    renderSection(makeQueryTransport({ status }));

    await waitFor(() => expect(screen.queryByTestId('settings-account-loading')).toBeNull());
    expect(status).toHaveBeenCalled();
    expect(screen.queryByTestId('settings-account-disconnected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByText("GitHub sign-in isn't available for this project")).toBeNull();
    expect(screen.getByTestId('settings-enterprise-hosts')).toBeDefined();
    expect(screen.getByTestId('settings-account-host-token')).toBeDefined();
    expect(getLastKnownSignedIn()).toBe(true);
  });

  test('an origin that names no host also hides the GitHub sign-in box', async () => {
    renderSection(
      makeQueryTransport({
        status: async () => ({
          authenticated: false,
          host: 'github.com',
          unsupportedOrigin: { host: null },
        }),
      }),
    );

    await waitFor(() => expect(screen.queryByTestId('settings-account-loading')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByTestId('settings-account-host-token')).toBeDefined();
  });

  test('clicking Sign in opens the AuthModal in connect mode (not reauth)', async () => {
    const user = userEvent.setup();
    renderSection(makeQueryTransport({ status: async () => NOT_CONNECTED }));

    await user.click(await screen.findByRole('button', { name: 'Sign in' }));

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

    expect(await screen.findByText('Connected to github.com as @octocat')).toBeDefined();
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
    expect(screen.queryByText('Connected to github.com as @octocat')).toBeNull();
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
    expect(screen.getByText('Connected to github.com as @octocat')).toBeDefined();
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
    expect(screen.getByText('Connected to github.com as @octocat')).toBeDefined();
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

    expect(await screen.findByText('Connected to github.com as @octocat')).toBeDefined();
    expect(getLastKnownSignedIn()).toBe(true);

    await user.click(screen.getByTestId('settings-account-disconnect'));
    await screen.findByText('Not connected');

    expect(getLastKnownSignedIn()).toBe(false);
  });

  test('gh-CLI tier names the host and the GitHub CLI, and no inert Disconnect control', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED_GH_CLI }));

    const ghRow = await screen.findByTestId('settings-account-gh-cli');
    expect(within(ghRow).getByText('Connected to github.com as @octocat')).toBeDefined();
    expect(ghRow.textContent).toContain(
      'Provided by the GitHub CLI (gh) on this computer. To switch accounts or sign out, run gh auth in a terminal.',
    );
    expect(ghRow.textContent).not.toContain('OpenKnowledge credential');
    expect(screen.queryByTestId('settings-account-disconnect')).toBeNull();
  });

  test('a GitHub Enterprise Server connection names that host', async () => {
    renderSection(
      makeQueryTransport({ status: async () => ({ ...CONNECTED, host: 'ghe.example.com' }) }),
    );

    const row = await screen.findByTestId('settings-account-connected');
    expect(within(row).getByText('Connected to ghe.example.com as @octocat')).toBeDefined();
  });

  test('a gh-CLI connection to a GitHub Enterprise Server names that host', async () => {
    renderSection(
      makeQueryTransport({
        status: async () => ({ ...CONNECTED_GH_CLI, host: 'ghe.example.com' }),
      }),
    );

    const ghRow = await screen.findByTestId('settings-account-gh-cli');
    expect(within(ghRow).getByText('Connected to ghe.example.com as @octocat')).toBeDefined();
  });

  test.each([
    ['an OK-stored token', CONNECTED, 'settings-account-connected'],
    ['a gh-CLI login', CONNECTED_GH_CLI, 'settings-account-gh-cli'],
    ['no connection', NOT_CONNECTED, 'settings-account-disconnected'],
  ] as const)(
    'the GitHub account status for %s sits under a GitHub heading',
    async (_label, result, testId) => {
      renderSection(makeQueryTransport({ status: async () => result }));

      const region = await screen.findByRole('region', { name: 'GitHub' });
      expect(within(region).getByTestId(testId)).toBeDefined();
      expect(region.getAttribute('data-field')).toBe('section:github-account');
    },
  );

  test('a project on a host that is not GitHub shows no empty GitHub heading', async () => {
    renderSection(
      makeQueryTransport({
        status: async () => ({
          authenticated: false as const,
          host: 'gitea.acme.test',
          unsupportedOrigin: { host: 'gitea.acme.test' },
        }),
      }),
    );

    await waitFor(() => expect(screen.queryByTestId('settings-account-loading')).toBeNull());
    expect(screen.queryByRole('region', { name: 'GitHub' })).toBeNull();
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

describe('hostFromRemoteLabel', () => {
  test('takes the host from an scp-derived remote label', () => {
    expect(hostFromRemoteLabel('gitea.internal/o/r')).toBe('gitea.internal');
  });

  test('takes the host from a scheme-derived remote label', () => {
    expect(hostFromRemoteLabel('git.example.com/team/notes')).toBe('git.example.com');
  });

  test('preserves an explicit port, which git keys credentials on', () => {
    expect(hostFromRemoteLabel('host:3000/o/r')).toBe('host:3000');
  });

  test('refuses a label that is still a raw URL', () => {
    expect(hostFromRemoteLabel('ssh://git.example.com/o/r')).toBe('');
  });

  test('refuses a label the remote parser could not reduce to a host', () => {
    expect(hostFromRemoteLabel('not a url at all')).toBe('');
  });

  test('refuses an empty label', () => {
    expect(hostFromRemoteLabel('')).toBe('');
  });
});

describe('AccountSection host-token prefill', () => {
  const realFetch = globalThis.fetch;
  let syncStatusCalls = 0;

  function stubSyncStatus(remote: { label: string; webUrl: string | null; transport?: string }) {
    syncStatusCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/api/sync/status')) {
        syncStatusCalls += 1;
        return new Response(JSON.stringify({ remote }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => setLastKnownSignedIn(null));
  afterEach(() => {
    cleanup();
    setLastKnownSignedIn(null);
    globalThis.fetch = realFetch;
  });

  test('seeds the host field from a non-GitHub remote', async () => {
    stubSyncStatus({ label: 'gitea.internal/o/r', webUrl: null });
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    await waitFor(() =>
      expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('gitea.internal'),
    );
    expect(screen.queryByTestId('settings-account-host-token-not-https')).toBeNull();
  });

  test.each(['ssh', 'git', 'http'])(
    'a %s remote is not seeded and says a stored token only applies over HTTPS',
    async (transport) => {
      stubSyncStatus({ label: 'gitea.internal/o/r', webUrl: null, transport });
      renderSection(makeQueryTransport({ status: async () => CONNECTED }));

      const note = await screen.findByTestId('settings-account-host-token-not-https');
      expect(note.textContent).toContain("this project's remote doesn't use HTTPS");
      expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('');
    },
  );

  test('an HTTPS remote is seeded without the not-HTTPS note', async () => {
    stubSyncStatus({ label: 'gitea.internal/o/r', webUrl: null, transport: 'https' });
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    await waitFor(() =>
      expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('gitea.internal'),
    );
    expect(screen.queryByTestId('settings-account-host-token-not-https')).toBeNull();
  });

  test('an unsupported origin still seeds the host field with the host git sends, port included', async () => {
    stubSyncStatus({ label: 'Git.Example.Internal:8443/o/r', webUrl: null, transport: 'https' });
    renderSection(
      makeQueryTransport({
        status: async () => ({
          authenticated: false,
          host: 'git.example.internal',
          unsupportedOrigin: { host: 'git.example.internal' },
        }),
      }),
    );

    await waitFor(() =>
      expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe(
        'Git.Example.Internal:8443',
      ),
    );
  });

  test('leaves the host field empty when the remote is GitHub', async () => {
    stubSyncStatus({ label: 'github.com/o/r', webUrl: 'https://github.com/o/r' });
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    await waitFor(() => expect(syncStatusCalls).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });

    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('');
  });

  test('never seeds over a host the user has already typed', async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    syncStatusCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/api/sync/status')) {
        await gate;
        syncStatusCalls += 1;
        return new Response(
          JSON.stringify({ remote: { label: 'gitea.internal/o/r', webUrl: null } }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    renderSection(makeQueryTransport({ status: async () => CONNECTED }));
    await user.type(await screen.findByLabelText('Host'), 'git.mine.test');

    release?.();
    await waitFor(() => expect(syncStatusCalls).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });

    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('git.mine.test');
  });
});

describe('AccountSection host-token form', () => {
  beforeEach(() => setLastKnownSignedIn(null));
  afterEach(() => {
    cleanup();
    setLastKnownSignedIn(null);
  });

  test('renders a host, username and access-token field with a submit control', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    expect(await screen.findByLabelText('Host')).toBeDefined();
    expect(screen.getByLabelText('Username')).toBeDefined();
    expect(screen.getByLabelText('Access token')).toBeDefined();
    expect(screen.getByTestId('settings-account-host-token-submit')).toBeDefined();
  });

  test('keeps submit disabled until all three fields hold a non-blank value', async () => {
    const user = userEvent.setup();
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    const submit = await screen.findByTestId('settings-account-host-token-submit');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText('Host'), 'gitea.internal');
    await user.type(screen.getByLabelText('Username'), 'oauth2');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText('Access token'), '   ');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText('Access token'), 'glpat_secret');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  test('a successful submit sends trimmed values, confirms, and clears only the token', async () => {
    const user = userEvent.setup();
    const calls: Array<[string, string, string]> = [];
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(async (host, username, token) => {
        calls.push([host, username, token]);
        return { ok: true, login: 'oauth2' };
      }),
    );

    await user.type(await screen.findByLabelText('Host'), '  gitea.internal  ');
    await user.type(screen.getByLabelText('Username'), '  oauth2  ');
    await user.type(screen.getByLabelText('Access token'), '  glpat_secret  ');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));

    const confirmation = await screen.findByTestId('settings-account-host-token-success');
    expect(confirmation.textContent).toBe(
      'Token stored for oauth2 on gitea.internal. To remove it, run ok auth signout --host gitea.internal.',
    );
    expect(calls).toEqual([['gitea.internal', 'oauth2', 'glpat_secret']]);
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('  gitea.internal  ');
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('  oauth2  ');
  });

  test('a rejected submit surfaces the reason and keeps the token for a retry', async () => {
    const user = userEvent.setup();
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(async () => ({ ok: false, error: 'Host must not include a scheme' })),
    );

    await user.type(await screen.findByLabelText('Host'), 'gitea.internal');
    await user.type(screen.getByLabelText('Username'), 'oauth2');
    await user.type(screen.getByLabelText('Access token'), 'glpat_secret');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));

    const alert = await screen.findByTestId('settings-account-host-token-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('Host must not include a scheme');
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('glpat_secret');
    expect(screen.queryByTestId('settings-account-host-token-success')).toBeNull();
  });

  test('Enter in the token field submits the form', async () => {
    const user = userEvent.setup();
    const calls: string[][] = [];
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(async (host, username, token) => {
        calls.push([host, username, token]);
        return { ok: true, login: username };
      }),
    );

    await user.type(await screen.findByLabelText('Host'), 'gitea.internal');
    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Access token'), 'tok{Enter}');

    expect(await screen.findByTestId('settings-account-host-token-success')).toBeDefined();
    expect(calls).toEqual([['gitea.internal', 'alice', 'tok']]);
  });

  test('a host with a scheme or path is refused before anything is sent', async () => {
    const user = userEvent.setup();
    const hostToken = vi.fn(async () => ({ ok: true, login: 'alice' }));
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(hostToken),
    );

    await user.type(await screen.findByLabelText('Host'), 'https://gitea.internal/team');
    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Access token'), 'tok');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));

    const alert = await screen.findByTestId('settings-account-host-token-error');
    expect(alert.textContent).toContain('no scheme or path');
    expect(hostToken).not.toHaveBeenCalled();
    const hostField = screen.getByLabelText('Host');
    expect(hostField.getAttribute('aria-invalid')).toBe('true');
    expect(hostField.getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.id).not.toBe('');
  });

  test('correcting the host after a format error clears the invalid state and its message', async () => {
    const user = userEvent.setup();
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(async () => ({ ok: true, login: 'alice' })),
    );

    const hostField = await screen.findByLabelText('Host');
    await user.type(hostField, 'https://gitea.internal/team');
    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Access token'), 'tok');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));
    await screen.findByTestId('settings-account-host-token-error');

    await user.clear(hostField);
    await user.type(hostField, 'gitea.internal');

    expect(hostField.hasAttribute('aria-invalid')).toBe(false);
    expect(hostField.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByTestId('settings-account-host-token-error')).toBeNull();
  });

  test('a valid host carries no invalid state and is not described by an error', async () => {
    const user = userEvent.setup();
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(async () => ({ ok: false, error: 'Rejected by host' })),
    );

    await user.type(await screen.findByLabelText('Host'), 'gitea.internal');
    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Access token'), 'tok');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));

    await screen.findByTestId('settings-account-host-token-error');
    const hostField = screen.getByLabelText('Host');
    expect(hostField.hasAttribute('aria-invalid')).toBe(false);
    expect(hostField.hasAttribute('aria-describedby')).toBe(false);
  });

  test('the username field is described by visible guidance naming the fixed usernames', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    const field = await screen.findByLabelText('Username');
    const hintId = field.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    const hint = document.getElementById(hintId as string);
    expect(hint).not.toBeNull();
    expect(hint?.closest('[role="tooltip"]')).toBeNull();
    for (const value of [
      'x-bitbucket-api-token-auth',
      'x-token-auth',
      'oauth2',
      'Gitea username',
      'Azure DevOps accepts any value',
    ]) {
      expect(hint?.textContent).toContain(value);
    }
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('a transport that throws re-enables the form, reports a connection error and logs the reason', async () => {
    const user = userEvent.setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('boom');
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(async () => {
        throw failure;
      }),
    );

    await user.type(await screen.findByLabelText('Host'), 'gitea.internal');
    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Access token'), 'tok');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));

    const alert = await screen.findByTestId('settings-account-host-token-error');
    expect(alert.textContent).toBe('Connection error — try again');
    expect(
      (screen.getByTestId('settings-account-host-token-submit') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(warn.mock.calls.some((call) => call.includes(failure))).toBe(true);
    warn.mockRestore();
  });

  test('an empty login from the transport falls back to the typed username', async () => {
    const user = userEvent.setup();
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(async () => ({ ok: true, login: '' })),
    );

    await user.type(await screen.findByLabelText('Host'), 'gitea.internal');
    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Access token'), 'tok');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));

    const confirmation = await screen.findByTestId('settings-account-host-token-success');
    expect(confirmation.textContent).toContain('Token stored for alice on gitea.internal.');
  });

  test('the token field opts out of browser and password-manager autofill', async () => {
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    const field = await screen.findByLabelText('Access token');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.hasAttribute('data-1p-ignore')).toBe(true);
    expect(field.getAttribute('data-lpignore')).toBe('true');
  });

  test('a transport that cannot store tokens explains itself instead of throwing', async () => {
    const user = userEvent.setup();
    renderSection(makeQueryTransport({ status: async () => CONNECTED }));

    await user.type(await screen.findByLabelText('Host'), 'gitea.internal');
    await user.type(screen.getByLabelText('Username'), 'oauth2');
    await user.type(screen.getByLabelText('Access token'), 'glpat_secret');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));

    const alert = await screen.findByTestId('settings-account-host-token-error');
    expect(alert.textContent).toBe(
      "This window can't store a token — open Settings from the main app window.",
    );
  });

  test('a rejected retry after a stored token drops the stale confirmation', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderSection(
      makeQueryTransport({ status: async () => CONNECTED }),
      makeAuthTransport(async () => {
        attempts += 1;
        return attempts === 1
          ? { ok: true, login: 'oauth2' }
          : { ok: false, error: 'Host must not include a scheme' };
      }),
    );

    await user.type(await screen.findByLabelText('Host'), 'gitea.internal');
    await user.type(screen.getByLabelText('Username'), 'oauth2');
    await user.type(screen.getByLabelText('Access token'), 'glpat_secret');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));
    await screen.findByTestId('settings-account-host-token-success');

    await user.type(screen.getByLabelText('Access token'), 'glpat_second');
    await user.click(screen.getByTestId('settings-account-host-token-submit'));

    await screen.findByTestId('settings-account-host-token-error');
    expect(screen.queryByTestId('settings-account-host-token-success')).toBeNull();
  });
});
