import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
  plural: (value: number, options: { one: string; other: string }) =>
    (value === 1 ? options.one : options.other).replace('#', String(value)),
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

let status: GitSyncStatus | null = null;
let fetchError: 'network' | 'server' | null = null;
let projectLocalConfig: {
  autoSync?: {
    enabled?: boolean | null;
    mode?: 'off' | 'follow' | 'full' | null;
    resumeMode?: 'follow' | 'full';
  };
} | null = {
  autoSync: { enabled: false },
};
let projectLocalSynced = true;
const patches: unknown[] = [];

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({ status, fetchError }),
}));

vi.doMock('@/hooks/use-conflicts', () => ({
  useConflicts: () => ({ conflicts: [{ file: 'docs/conflicted.md' }] }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalConfig,
    projectLocalSynced,
    projectLocalBinding: {
      patch: (patch: unknown) => {
        patches.push(patch);
        return { ok: true as const };
      },
    },
  }),
}));

const baseStatus: GitSyncStatus = {
  state: 'idle',
  lastSyncUtc: null,
  lastFetchUtc: null,
  ahead: 0,
  behind: 0,
  conflictCount: 0,
  hasRemote: true,
  syncEnabled: true,
  remote: { label: 'inkeep/open-knowledge', webUrl: 'https://github.com/inkeep/open-knowledge' },
};

async function renderBadge(props: { onSignIn?: () => void } = {}) {
  const { SyncStatusBadge } = await import('./SyncStatusBadge');
  render(
    <TooltipProvider>
      <SyncStatusBadge {...props} />
    </TooltipProvider>,
  );
}

async function openPopover() {
  await userEvent.click(screen.getByRole('button', { name: /Sync status:/ }));
  await waitFor(() => {
    expect(screen.getByText('Repository')).toBeTruthy();
  });
}

describe('SyncStatusBadge helper behavior', () => {
  test('shouldDisableSyncSwitch only blocks before project-local sync or after push denial', async () => {
    const { shouldDisableSyncSwitch } = await import('./SyncStatusBadge');

    expect(shouldDisableSyncSwitch(false, 'allowed')).toBe(true);
    expect(shouldDisableSyncSwitch(true, 'denied')).toBe(true);
    expect(shouldDisableSyncSwitch(true, 'allowed')).toBe(false);
    expect(shouldDisableSyncSwitch(true, 'unknown')).toBe(false);
    expect(shouldDisableSyncSwitch(true, undefined)).toBe(false);
  });

  test('formats push-permission denial reasons into actionable copy', async () => {
    const { formatPushPermissionDenied } = await import('./SyncStatusBadge');

    expect(formatPushPermissionDenied('no-collaborator')).toEqual([
      "You don't have permission to push to this repo.",
    ]);
    expect(formatPushPermissionDenied('private-no-access')).toEqual([
      "You don't have access to this private repo. Sign in with an account that does.",
    ]);
    expect(formatPushPermissionDenied('repo-not-found')).toEqual([
      'Repository not found. It may have been renamed, deleted, or moved.',
    ]);
    expect(formatPushPermissionDenied(undefined)).toEqual([
      "You don't have permission to push to this repo.",
    ]);
  });

  test('denials name the authenticated identity when the wire carries it', async () => {
    const { formatPushPermissionDenied } = await import('./SyncStatusBadge');

    expect(formatPushPermissionDenied('private-no-access', { resolvedLogin: 'bob' })).toEqual([
      "You don't have access to this private repo. Sign in with an account that does.",
      'Authenticated as bob.',
    ]);
    // The read-only-collaborator verdict is exactly as account-dependent as
    // the private-repo 404 — the personal-token-against-org-repo case lands
    // here, and the identity is what lets the user spot it.
    expect(formatPushPermissionDenied('no-collaborator', { resolvedLogin: 'bob' })).toEqual([
      "You don't have permission to push to this repo.",
      'Authenticated as bob.',
    ]);
    // No identity on the wire → base copy exactly; the UI never guesses a login.
    expect(formatPushPermissionDenied('private-no-access', {})).toEqual([
      "You don't have access to this private repo. Sign in with an account that does.",
    ]);
  });

  test('a declared login that missed adds the actionable fact, worded by its source', async () => {
    const { formatPushPermissionDenied } = await import('./SyncStatusBadge');

    expect(
      formatPushPermissionDenied('private-no-access', {
        resolvedLogin: 'bob',
        declaredLogin: 'alice',
        declaredSource: 'remote-url',
      }),
    ).toEqual([
      "You don't have access to this private repo. Sign in with an account that does.",
      'Authenticated as bob.',
      "Your remote URL names alice, but that account's credentials couldn't be used.",
    ]);
  });

  test('credential-config and unknown declaration sources get their own wording', async () => {
    const { formatPushPermissionDenied } = await import('./SyncStatusBadge');

    expect(
      formatPushPermissionDenied('no-collaborator', {
        declaredLogin: 'workbot',
        declaredSource: 'credential-config',
      }),
    ).toEqual([
      "You don't have permission to push to this repo.",
      "Your Git credential configuration names workbot, but that account's credentials couldn't be used.",
    ]);
    // declaredSource is an open string on the wire: a newer server's declaration
    // mechanism must degrade to generic wording, not drop the actionable fact.
    expect(
      formatPushPermissionDenied('no-collaborator', {
        declaredLogin: 'workbot',
        declaredSource: 'far-future-mechanism',
      }),
    ).toEqual([
      "You don't have permission to push to this repo.",
      "Your Git configuration names workbot, but that account's credentials couldn't be used.",
    ]);
  });

  // The miss copy must not blame a specific tool: the wire does not say
  // whether the GitHub CLI was consulted, absent, or outdated — and desktop
  // installs with no gh reach the same path via the signed-out short-circuit.
  test('the declared-miss sentence asserts the miss without naming a cause', async () => {
    const { formatPushPermissionDenied } = await import('./SyncStatusBadge');

    const signedOut = formatPushPermissionDenied('not-authenticated', {
      declaredLogin: 'alice',
      declaredSource: 'remote-url',
    });
    expect(signedOut).toEqual([
      "You're signed out — sign in to resume syncing.",
      "Your remote URL names alice, but that account's credentials couldn't be used.",
    ]);
    expect(signedOut.join(' ')).not.toContain('GitHub CLI');
  });

  test('the declared-but-missed login is never named as the authenticated identity', async () => {
    const { formatPushPermissionDenied } = await import('./SyncStatusBadge');

    const message = formatPushPermissionDenied('private-no-access', {
      resolvedLogin: 'bob',
      declaredLogin: 'alice',
      declaredSource: 'remote-url',
    }).join(' ');
    expect(message).toContain('Authenticated as bob.');
    expect(message).not.toContain('Authenticated as alice');
    // Without a resolvedLogin the identity sentence is omitted entirely —
    // the declared login must not be promoted into it.
    const fallbackUnnamed = formatPushPermissionDenied('private-no-access', {
      declaredLogin: 'alice',
      declaredSource: 'remote-url',
    }).join(' ');
    expect(fallbackUnnamed).not.toContain('Authenticated as');
    expect(fallbackUnnamed).toContain('Your remote URL names alice');
  });

  // The engine parks the not-found masquerade as auth-error, but the badge
  // must not pair "no prescribed fix" copy with a Sign in affordance — the
  // predicate is what gates the button, the header, and the paused line.
  test('hasNotFoundAsIdentityError keys off either direction error code', async () => {
    const { hasNotFoundAsIdentityError } = await import('./SyncStatusBadge');

    expect(hasNotFoundAsIdentityError({ pushErrorCode: 'auth-not-found-as-identity' })).toBe(true);
    expect(hasNotFoundAsIdentityError({ pullErrorCode: 'auth-not-found-as-identity' })).toBe(true);
    expect(hasNotFoundAsIdentityError({ pushErrorCode: 'auth-401' })).toBe(false);
    expect(hasNotFoundAsIdentityError({})).toBe(false);
  });

  test('collapses or labels push/pull sync errors by root cause', async () => {
    const { computeSyncErrorLines } = await import('./SyncStatusBadge');

    expect(computeSyncErrorLines({ pushErrorCode: 'auth-401' })).toEqual([
      {
        key: 'push',
        direction: null,
        message: 'GitHub authentication failed. Try signing in again.',
      },
    ]);
    expect(
      computeSyncErrorLines({
        pushErrorCode: 'auth-401',
        pullErrorCode: 'auth-401',
      }),
    ).toEqual([
      {
        key: 'sync',
        direction: null,
        message: 'GitHub authentication failed. Try signing in again.',
      },
    ]);
    expect(
      computeSyncErrorLines({
        pushErrorCode: 'semantic-protected-branch',
        pullErrorCode: 'auth-403',
      }),
    ).toEqual([
      {
        key: 'push',
        direction: 'push',
        message: 'The default branch is protected — pushes need a pull request.',
      },
      {
        key: 'pull',
        direction: 'pull',
        message: "You don't have access to this repository.",
      },
    ]);
    expect(
      computeSyncErrorLines({
        pushError: 'same raw failure',
        pullError: 'same raw failure',
      }),
    ).toEqual([{ key: 'sync', direction: null, message: 'same raw failure' }]);
  });

  test('auth-no-credential copy directs the user to reconnect', async () => {
    const { formatPullFailureCode, formatPushFailureCode, formatSyncFailureCode } = await import(
      './SyncStatusBadge'
    );

    for (const format of [formatSyncFailureCode, formatPushFailureCode, formatPullFailureCode]) {
      expect(format('auth-no-credential')).toMatch(/reconnect/i);
    }
  });

  test('a not-found failure states not-found-or-no-access without claiming which', async () => {
    const { formatPullFailureCode, formatPushFailureCode, formatSyncFailureCode } = await import(
      './SyncStatusBadge'
    );

    // The classifier cannot tell a missing repo from an invisible one (GitHub
    // answers 404 for both), so the copy asserts only the ambiguity and never
    // offers sign-in as the fix.
    for (const format of [formatSyncFailureCode, formatPushFailureCode, formatPullFailureCode]) {
      expect(format('auth-not-found-as-identity')).toBe(
        'Repository not found — it may not exist, or the account used may not have access.',
      );
    }
  });

  test('an unrecognized sync error code renders generic fallback copy (older client, newer server)', async () => {
    const { formatPullFailureCode, formatPushFailureCode, formatSyncFailureCode } = await import(
      './SyncStatusBadge'
    );

    // A client whose bundle predates a server-added code must render a
    // meaningful generic line, not an empty styled-red paragraph. The sync
    // status wire is not schema-validated client-side, so the unknown code
    // string reaches these formatters as-is — this default branch IS the
    // version-skew degradation path for the bounded error-code enum.
    const futureCode = 'auth-far-future' as Parameters<typeof formatPushFailureCode>[0];
    expect(formatPushFailureCode(futureCode)).toBe(
      'Push failed — check the server logs for details.',
    );
    expect(formatPullFailureCode(futureCode)).toBe(
      'Fetch failed — check the server logs for details.',
    );
    expect(formatSyncFailureCode(futureCode)).toBe(
      'Sync failed — check the server logs for details.',
    );
  });

  test('only token-invalid unknown push-permission probes offer sign-in again', async () => {
    const { shouldOfferSignInAgain } = await import('./SyncStatusBadge');

    expect(shouldOfferSignInAgain({ checkStatus: 'unknown', unknownError: 'token-invalid' })).toBe(
      true,
    );
    expect(shouldOfferSignInAgain({ checkStatus: 'denied' })).toBe(false);
    expect(shouldOfferSignInAgain({ checkStatus: 'unknown', unknownError: 'network' })).toBe(false);
    // ssh-unverified is the abstaining probe result for SSH-origin repos with
    // no GitHub credential. Signing in can never help there (push auths with
    // SSH keys), so broadening this predicate to match it would resurrect the
    // misleading sign-in affordance the transport-keyed probe fix removed.
    expect(shouldOfferSignInAgain({ checkStatus: 'unknown', unknownError: 'ssh-unverified' })).toBe(
      false,
    );
    expect(shouldOfferSignInAgain(undefined)).toBe(false);
  });

  test('a pull-only toggle stays enabled even when push is denied', async () => {
    const { shouldDisableSyncSwitch } = await import('./SyncStatusBadge');

    // Pull-only never pushes, so a denied probe is irrelevant to its toggle.
    expect(shouldDisableSyncSwitch(true, 'denied', 'follow')).toBe(false);
    // Off/full still gate on denial — enabling there reaches push-requiring full sync.
    expect(shouldDisableSyncSwitch(true, 'denied', 'off')).toBe(true);
    expect(shouldDisableSyncSwitch(true, 'denied', 'full')).toBe(true);
    // Cold start (project-local config not yet synced) disables regardless of mode.
    expect(shouldDisableSyncSwitch(false, 'allowed', 'follow')).toBe(true);
  });

  test('displayState promotes a pull-only idle-with-conflicts project to conflict', async () => {
    const { displayState } = await import('./SyncStatusBadge');

    expect(
      displayState({ ...baseStatus, syncMode: 'follow', state: 'idle', conflictCount: 1 }),
    ).toBe('conflict');
    // No conflicts, or full sync, leaves the state untouched (full sets 'conflict' itself).
    expect(
      displayState({ ...baseStatus, syncMode: 'follow', state: 'idle', conflictCount: 0 }),
    ).toBe('idle');
    expect(displayState({ ...baseStatus, syncMode: 'full', state: 'idle', conflictCount: 1 })).toBe(
      'idle',
    );
    expect(
      displayState({ ...baseStatus, syncMode: 'follow', state: 'pulling', conflictCount: 1 }),
    ).toBe('pulling');
  });

  test('tooltipLabel frames a following project as up to date, never "Sync off"', async () => {
    const { tooltipLabel } = await import('./SyncStatusBadge');
    const following = { ...baseStatus, syncMode: 'follow' as const };

    expect(tooltipLabel({ ...following, state: 'idle', behind: 0 })).toBe('Up to date');
    expect(tooltipLabel({ ...following, state: 'idle', behind: 3 })).toBe('3 behind');
    expect(tooltipLabel({ ...following, state: 'pulling' })).toBe('Updating');
    expect(tooltipLabel({ ...following, state: 'idle', conflictCount: 2 })).toBe('2 conflicts');
    // Even a following payload that arrives with syncEnabled false is never "Sync off".
    expect(tooltipLabel({ ...following, state: 'idle', syncEnabled: false })).toBe('Up to date');
    // Full sync is unchanged.
    expect(tooltipLabel({ ...baseStatus, state: 'idle' })).toBe('Synced');
    expect(tooltipLabel({ ...baseStatus, state: 'idle', syncEnabled: false })).toBe('Sync off');
  });

  test('formatPausedReason explains a pull-only divergence in plain language', async () => {
    const { formatPausedReason } = await import('./SyncStatusBadge');
    expect(formatPausedReason('diverged-local-commits')).toBe(
      'Local commits are keeping this copy from updating',
    );
  });
});

describe('SyncStatusBadge runtime behavior', () => {
  afterEach(() => {
    cleanup();
    status = null;
    fetchError = null;
    projectLocalConfig = { autoSync: { enabled: false } };
    projectLocalSynced = true;
    patches.length = 0;
  });

  test('exports the SyncStatusBadge component', async () => {
    const mod = await import('./SyncStatusBadge');
    expect(typeof mod.SyncStatusBadge).toBe('function');
  });

  test('renders nothing before status loads unless a fetch error exists', async () => {
    status = null;
    fetchError = null;
    await renderBadge();

    expect(screen.queryByRole('button')).toBeNull();
  });

  test.each([
    ['disabled without paused reason', { state: 'disabled', pausedReason: undefined }],
    ['dormant without a remote', { state: 'dormant', hasRemote: false }],
  ] as const)('hides %s', async (_label, override) => {
    status = { ...baseStatus, ...override } as GitSyncStatus;
    await renderBadge();

    expect(screen.queryByRole('button')).toBeNull();
  });

  test.each([
    ['auth-error', { state: 'auth-error', syncEnabled: true }],
    ['conflict', { state: 'conflict', conflictCount: 2, syncEnabled: true }],
    ['offline', { state: 'offline', syncEnabled: true }],
    ['dormant with remote', { state: 'dormant', hasRemote: true, syncEnabled: false }],
    [
      'disabled with paused reason',
      { state: 'disabled', pausedReason: 'protected-branch', syncEnabled: false },
    ],
  ] as const)('keeps attention-worthy state visible: %s', async (_label, override) => {
    status = { ...baseStatus, ...override } as GitSyncStatus;
    await renderBadge();

    expect(screen.getByRole('button', { name: /Sync status:/ })).toBeTruthy();
  });

  test('stays visible while a resume is in flight (config active, server still disabled)', async () => {
    // Resuming from paused flips the local config mode 'off'→active optimistically
    // (so `paused` clears) while the server status still lags at disabled/off. The
    // badge must stay mounted in that window — unmounting closes the popover and
    // flickers the icon (the user toggles on, the popover vanishes, then returns).
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    status = {
      ...baseStatus,
      state: 'disabled',
      syncEnabled: false,
      syncMode: 'off',
      pausedReason: undefined,
    } as GitSyncStatus;
    await renderBadge();

    expect(screen.getByRole('button', { name: /Sync status:/ })).toBeTruthy();
  });

  test('paused disabled state opens details explaining why sync stopped', async () => {
    status = {
      ...baseStatus,
      state: 'disabled',
      syncEnabled: false,
      pausedReason: 'protected-branch',
    };
    await renderBadge();
    await openPopover();

    expect(screen.getByText('Protected branch — cannot push')).toBeTruthy();
  });

  test('popover switch is on (Pause sync) when a mode is active', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { enabled: true } };
    await renderBadge();
    await openPopover();

    const toggle = screen.getByRole('switch', { name: 'Pause sync' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  test('popover switch is disabled until the project-local config has synced', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { enabled: false } };
    projectLocalSynced = false;
    await renderBadge();
    await openPopover();

    const toggle = screen.getByRole('switch', { name: 'Resume sync' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });

  test('resuming from off opens confirmation before patching (defaults to full)', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { enabled: false } };
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByRole('switch', { name: 'Resume sync' }));
    expect(patches).toEqual([]);

    // Resuming a never-enabled project defaults to full sync (which pushes), so
    // it confirms; the write clears the resume memory.
    await userEvent.click(screen.getByRole('button', { name: 'Enable auto-sync' }));
    expect(patches).toEqual([{ autoSync: { mode: 'full', enabled: null, resumeMode: null } }]);
  });

  test.each([
    ['idle', { state: 'idle' }, 'Sync status: Up to date'],
    ['pulling', { state: 'pulling' }, 'Sync status: Updating'],
    ['fetching', { state: 'fetching' }, 'Sync status: Checking for updates'],
    ['offline', { state: 'offline' }, 'Sync status: Offline'],
    ['auth-error', { state: 'auth-error' }, 'Sync status: Reconnect required'],
  ] as const)('pull-only %s renders a distinct following badge', async (_label, override, ariaName) => {
    status = { ...baseStatus, syncMode: 'follow', ...override } as GitSyncStatus;
    await renderBadge();

    expect(screen.getByRole('button', { name: ariaName })).toBeTruthy();
  });

  test('pull-only conflict surfaces on the badge even though the engine stays idle', async () => {
    // Pull-only holds the engine idle while a same-line collision waits in the
    // ledger; the badge promotes conflictCount to the conflict rendering.
    status = {
      ...baseStatus,
      syncMode: 'follow',
      state: 'idle',
      conflictCount: 1,
    } as GitSyncStatus;
    await renderBadge();

    expect(screen.getByRole('button', { name: 'Sync status: Conflict' })).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  test('pull-only stays visible even in a disabled-without-reason payload', async () => {
    // The engine never parks a pull-only project here, but the hide rule must
    // exempt following projects so one is never silently hidden.
    status = {
      ...baseStatus,
      syncMode: 'follow',
      state: 'disabled',
      pausedReason: undefined,
    } as GitSyncStatus;
    await renderBadge();

    expect(screen.getByRole('button', { name: /Sync status:/ })).toBeTruthy();
  });

  test('following popover shows the follow state, not "sync off", with a Sync action', async () => {
    status = { ...baseStatus, syncMode: 'follow', state: 'idle' } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    await renderBadge();
    await openPopover();

    const toggle = screen.getByRole('switch', { name: 'Pause sync' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(/Sync is off/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeTruthy();
  });

  test('following popover keeps the Switch reachable when push is denied', async () => {
    status = {
      ...baseStatus,
      syncMode: 'follow',
      state: 'idle',
      pushPermission: { checkStatus: 'denied' },
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    await renderBadge();
    await openPopover();

    const toggle = screen.getByRole('switch', { name: 'Pause sync' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
  });

  test('following popover states the mode instead of the push-permission verdict', async () => {
    status = {
      ...baseStatus,
      syncMode: 'follow',
      state: 'idle',
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    await renderBadge();
    await openPopover();

    expect(screen.getByTestId('sync-popover-mode-line').textContent).toContain('Follow');
    expect(screen.queryByText(/don't have permission to push/)).toBeNull();
    // A genuine read-only user cannot choose Full, so the mode toggle is hidden.
    expect(screen.queryByTestId('sync-popover-mode-toggle')).toBeNull();
  });

  test('pull-only popover suppresses the signed-out reconnect line (push-framed)', async () => {
    status = {
      ...baseStatus,
      syncMode: 'follow',
      state: 'idle',
      pushPermission: { checkStatus: 'denied', deniedReason: 'not-authenticated' },
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    await renderBadge();
    await openPopover();

    expect(screen.queryByText(/signed out — sign in to resume syncing/)).toBeNull();
    expect(screen.getByTestId('sync-popover-mode-line')).toBeTruthy();
  });

  // The signed-out reconnect arm: the most common auth failure shape, and one
  // of the two arms that render a Sign in Button outside the live region.
  test('a signed-out denial renders the reconnect line and its Sign in button', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      pushPermission: { checkStatus: 'denied', deniedReason: 'not-authenticated' },
    };
    await renderBadge({ onSignIn: () => {} });
    await openPopover();

    expect(screen.getByText(/signed out — sign in to resume syncing/)).toBeTruthy();
    // Exactly one Sign in exists here (the header's is gated on auth-error),
    // so this resolves to the reconnect arm's own button — and it must sit
    // OUTSIDE the live region: role="status" is implicitly aria-atomic, so a
    // button inside it would be re-announced on every status text change.
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect(signIn).toBeTruthy();
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
  });

  // Precedence: the signed-out reconnect must beat the paused-reason arm. A
  // parked engine reaches both, and losing the order strands that user with
  // "Reconnect required" and no affordance — copy prescribing an action the
  // popover no longer offers.
  test('a signed-out denial outranks the paused-reason line when the engine is parked', async () => {
    status = {
      ...baseStatus,
      state: 'auth-error',
      pausedReason: 'auth-error',
      pushPermission: { checkStatus: 'denied', deniedReason: 'not-authenticated' },
    };
    await renderBadge({ onSignIn: () => {} });
    await openPopover();

    expect(screen.getByText(/signed out — sign in to resume syncing/)).toBeTruthy();
    // "Reconnect required" is the popover header here, and correctly so — a
    // signed-out denial IS reconnect-fixable. What must not appear is a
    // SECOND copy from the paused-reason arm, which would mean that arm won
    // the chain and the reconnect affordance was dropped.
    expect(screen.getAllByText('Reconnect required')).toHaveLength(1);
    // The live region carries status text only — the Sign in row renders
    // outside it, so a text change never re-announces a button label.
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
  });

  // The probe-401 arm: the other Sign-in-bearing arm, and the last one in the
  // chain, so an arm reordered above it silently swallows this state.
  test('a probe-401 renders the sign-in-again line and its button', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      pushPermission: { checkStatus: 'unknown', unknownError: 'token-invalid' },
    };
    await renderBadge({ onSignIn: () => {} });
    await openPopover();

    expect(screen.getByText(/GitHub session expired — sign in again/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  test('the denied popover line renders the identity sentences from the wire payload', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      pushPermission: {
        checkStatus: 'denied',
        deniedReason: 'private-no-access',
        resolvedLogin: 'bob',
        declaredLogin: 'alice',
        declaredSource: 'remote-url',
      },
    };
    await renderBadge();
    await openPopover();

    // Sentences render one per line, so each is asserted as its own element.
    expect(screen.getByText(/don't have access to this private repo/)).toBeTruthy();
    expect(screen.getByText('Authenticated as bob.')).toBeTruthy();
    expect(
      screen.getByText(
        "Your remote URL names alice, but that account's credentials couldn't be used.",
      ),
    ).toBeTruthy();
  });

  // The engine parks the not-found masquerade as auth-error, but the popover
  // must not pair "may not exist / may not have access" copy with a Sign in
  // button — the copy and the affordance have to agree.
  test('a not-found-as-identity auth error withdraws the Sign in affordance', async () => {
    status = {
      ...baseStatus,
      state: 'auth-error',
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-not-found-as-identity',
    };
    await renderBadge();
    await openPopover();

    expect(screen.getByText(/Repository not found — it may not exist/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByText('Reconnect required')).toBeNull();
    // The header names the symptom instead.
    expect(screen.getAllByText('Repository not found').length).toBeGreaterThan(0);
    // The accessible name reads the same derivation as the visible surfaces —
    // a screen reader must not hear the reconnect prescription the popover
    // withdrew (queryByText matches text content, never aria-label, so only
    // a role+name query can pin this).
    expect(screen.getByRole('button', { name: 'Sync status: Repository not found' })).toBeTruthy();
    // The error/guidance block is a polite live region, so the state flip is
    // announced to an open popover instead of changing silently.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  // The parked engine keeps the last probe verdict in `pushPermission`; when
  // that verdict is a denial, its identity sentences must survive into the
  // parked popover — the account used is the fact this state turns on.
  test('a parked not-found error still names the account when a denied verdict is in hand', async () => {
    status = {
      ...baseStatus,
      state: 'auth-error',
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-not-found-as-identity',
      pushPermission: {
        checkStatus: 'denied',
        deniedReason: 'private-no-access',
        resolvedLogin: 'bob',
      },
    };
    await renderBadge();
    await openPopover();

    // The masquerade's probe also answers `denied`, but that is not a
    // collaborator verdict — so the Mode chooser stays available here, the
    // same call Settings makes for the identical status object. Two surfaces,
    // one status, one answer.
    expect(screen.getByTestId('sync-popover-mode-toggle')).toBeTruthy();
    expect(screen.getByText('Authenticated as bob.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    // Only the identity tail rides along — the denial's REASON sentence
    // re-prescribes the sign-in this state withholds (and asserts more than
    // the 404 proves), so it must not render next to the not-found copy.
    expect(screen.queryByText(/Sign in with an account that does/)).toBeNull();
    expect(screen.queryByText(/don't have access to this private repo/)).toBeNull();
  });

  // A push-permission pause and a genuine read-only collaborator produce the
  // same sentence, so without the identity tail a two-account user cannot tell
  // "wrong account" from "you were never a collaborator".
  test('a push-permission pause names the account that was actually used', async () => {
    status = {
      ...baseStatus,
      state: 'disabled',
      syncEnabled: false,
      pausedReason: 'no-push-permission',
      pushPermission: {
        checkStatus: 'denied',
        deniedReason: 'private-no-access',
        resolvedLogin: 'bob',
      },
    };
    await renderBadge();
    await openPopover();

    // The pause is real and stays the headline; the identity rides along.
    expect(screen.getByText("You don't have permission to push to this repo.")).toBeTruthy();
    expect(screen.getByText('Authenticated as bob.')).toBeTruthy();
  });

  test('other auth errors keep the Sign in affordance and the reconnect header', async () => {
    status = {
      ...baseStatus,
      state: 'auth-error',
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-401',
    };
    await renderBadge();
    await openPopover();

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getAllByText('Reconnect required').length).toBeGreaterThan(0);
  });

  test('a paused (was-enabled) project stays visible and shows the paused popover', async () => {
    // Engine reports a paused project as disabled; the config (resumeMode set)
    // keeps the badge visible and drives the paused rendering.
    status = {
      ...baseStatus,
      state: 'disabled',
      syncMode: 'off',
      pausedReason: undefined,
      syncEnabled: false,
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off', resumeMode: 'full' } };
    await renderBadge();

    // Not hidden (the disabled-hide rule exempts a paused project).
    expect(screen.getByRole('button', { name: 'Sync status: Sync paused' })).toBeTruthy();
    await openPopover();

    expect(screen.getByTestId('sync-popover-paused-line')).toBeTruthy();
    // Switch is off (resume), and a manual Sync is still offered (ever enabled).
    expect(screen.getByRole('switch', { name: 'Resume sync' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'Sync' })).toBeTruthy();
    // The mode is still editable while paused (push-capable user).
    expect(screen.getByTestId('sync-popover-mode-toggle')).toBeTruthy();
  });

  test('changing the mode while paused only updates the resume memory (no sync)', async () => {
    status = {
      ...baseStatus,
      state: 'disabled',
      syncMode: 'off',
      syncEnabled: false,
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off', resumeMode: 'full' } };
    await renderBadge();
    await openPopover();

    // Flip Full → Follow while paused: writes resumeMode only, mode stays off,
    // no confirmation (nothing syncs until the Switch is turned on).
    await userEvent.click(screen.getByTestId('sync-popover-mode-follow'));
    expect(patches).toEqual([{ autoSync: { resumeMode: 'follow' } }]);
  });

  test('the manual Sync action is hidden for a never-enabled project', async () => {
    // Off with no resume memory = never enabled → no manual Sync affordance.
    status = {
      ...baseStatus,
      state: 'dormant',
      syncMode: 'off',
      syncEnabled: false,
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
  });
});
