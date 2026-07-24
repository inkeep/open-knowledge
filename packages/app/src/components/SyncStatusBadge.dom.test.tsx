import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

async function renderBadge() {
  const { SyncStatusBadge } = await import('./SyncStatusBadge');
  render(
    <TooltipProvider>
      <SyncStatusBadge />
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

    expect(formatPushPermissionDenied('no-collaborator')).toBe(
      "You don't have permission to push to this repo",
    );
    expect(formatPushPermissionDenied('private-no-access')).toBe(
      "You don't have access to this private repo. Sign in with an account that does.",
    );
    expect(formatPushPermissionDenied('repo-not-found')).toBe(
      'Repository not found. It may have been renamed, deleted, or moved.',
    );
    expect(formatPushPermissionDenied(undefined)).toBe(
      "You don't have permission to push to this repo",
    );
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
