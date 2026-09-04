import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect, useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

let forceStatusRender: (() => void) | null = null;
vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => {
    const [, force] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      forceStatusRender = force;
      return () => {
        forceStatusRender = null;
      };
    }, []);
    return { status, fetchError };
  },
}));

vi.doMock('@/hooks/use-conflicts', () => ({
  useConflicts: () => ({ conflicts: [{ file: 'docs/conflicted.md' }] }),
}));

type WorktreeTestEntry = {
  path: string;
  code: string;
  syncScoped: boolean;
  open?: { kind: 'doc'; docName: string } | { kind: 'asset'; path: string };
};

let worktree: {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  staged: WorktreeTestEntry[];
  notStaged: WorktreeTestEntry[];
  untracked: WorktreeTestEntry[];
  incoming: WorktreeTestEntry[];
  truncated: boolean;
  readable?: boolean;
} | null = null;

vi.doMock('@/hooks/use-git-worktree-status', () => ({
  useGitWorktreeStatus: () => ({ status: worktree, loading: worktree === null }),
}));

const triggered: string[] = [];
let triggerRejection: Error | null = null;
vi.doMock('@/lib/trigger-sync', () => ({
  triggerSync: (op: string) => {
    triggered.push(op);
    return triggerRejection ? Promise.reject(triggerRejection) : Promise.resolve();
  },
}));

let settingsNavigations: string[] = [];
vi.doMock('@/lib/use-settings-route', () => ({
  openSyncSettings: () => {
    settingsNavigations.push('sync');
  },
}));

const emptyWorktree = {
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  staged: [],
  notStaged: [],
  untracked: [],
  incoming: [],
  truncated: false,
};

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
    expect(screen.getByTestId('sync-mode-select')).toBeTruthy();
  });
}

async function expandWorktreeListing(): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    const listing = screen.queryByTestId('worktree-listing');
    if (!listing) return;
    const collapsed = within(listing).queryAllByRole('button', { expanded: false });
    if (collapsed.length === 0) return;
    for (const trigger of collapsed) await userEvent.click(trigger);
  }
  throw new Error(
    'expandWorktreeListing: disclosures still collapsed after 4 passes — a new nesting tier?',
  );
}

async function advanceStatus(next: GitSyncStatus): Promise<void> {
  status = next;
  await act(async () => {
    forceStatusRender?.();
  });
}

function spinnerIn(testId: string): HTMLElement | null {
  return within(screen.getByTestId(testId)).queryByRole('status', { hidden: true });
}

function selectedMode(): string {
  return screen.getByTestId('sync-mode-select').textContent ?? '';
}

describe('SyncStatusBadge helper behavior', () => {
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
    expect(formatPushPermissionDenied('no-collaborator', { resolvedLogin: 'bob' })).toEqual([
      "You don't have permission to push to this repo.",
      'Authenticated as bob.',
    ]);
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
    const fallbackUnnamed = formatPushPermissionDenied('private-no-access', {
      declaredLogin: 'alice',
      declaredSource: 'remote-url',
    }).join(' ');
    expect(fallbackUnnamed).not.toContain('Authenticated as');
    expect(fallbackUnnamed).toContain('Your remote URL names alice');
  });

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
    expect(shouldOfferSignInAgain({ checkStatus: 'unknown', unknownError: 'ssh-unverified' })).toBe(
      false,
    );
    expect(shouldOfferSignInAgain(undefined)).toBe(false);
  });

  test('displayState promotes a pull-only idle-with-conflicts project to conflict', async () => {
    const { displayState } = await import('./SyncStatusBadge');

    expect(
      displayState({ ...baseStatus, syncMode: 'follow', state: 'idle', conflictCount: 1 }),
    ).toBe('conflict');
    expect(
      displayState({ ...baseStatus, syncMode: 'follow', state: 'idle', conflictCount: 0 }),
    ).toBe('idle');
    expect(displayState({ ...baseStatus, syncMode: 'full', state: 'idle', conflictCount: 1 })).toBe(
      'conflict',
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
    expect(tooltipLabel({ ...following, state: 'idle', syncEnabled: false })).toBe('Up to date');
    expect(tooltipLabel({ ...baseStatus, state: 'idle' })).toBe('Synced');
    expect(tooltipLabel({ ...baseStatus, state: 'idle', syncEnabled: false })).toBe('Synced');
    expect(tooltipLabel({ ...baseStatus, state: 'idle', syncEnabled: false, behind: 2 })).toBe(
      '2 behind',
    );
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
    worktree = emptyWorktree;
    triggered.length = 0;
    triggerRejection = null;
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

  test('hides only when there is no git remote', async () => {
    status = { ...baseStatus, state: 'dormant', hasRemote: false } as GitSyncStatus;
    await renderBadge();

    expect(screen.queryByRole('button')).toBeNull();
  });

  test('Manual never renders as a fault — no warning glyph, no "disabled" copy', async () => {
    status = {
      ...baseStatus,
      state: 'disabled',
      syncEnabled: false,
      syncMode: 'off',
      pausedReason: undefined,
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();

    expect(screen.getByRole('button', { name: 'Sync status: Manual' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /disabled/i })).toBeNull();
  });

  test('an auto-disable still reads as a fault — pausedReason is the discriminator', async () => {
    status = {
      ...baseStatus,
      state: 'disabled',
      syncEnabled: false,
      syncMode: 'full',
      pausedReason: 'protected-branch',
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'full' } };
    await renderBadge();

    expect(screen.getByRole('button', { name: 'Sync status: Sync paused' })).toBeTruthy();
  });

  test('a manual (mode off) project stays visible — Manual is a resting mode, not an opt-out', async () => {
    status = {
      ...baseStatus,
      state: 'disabled',
      syncEnabled: false,
      syncMode: 'off',
      pausedReason: undefined,
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();

    expect(screen.getByRole('button', { name: /Sync status:/ })).toBeTruthy();
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

  test('the mode selector reflects the resolved local mode', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { enabled: true } };
    await renderBadge();
    await openPopover();

    expect(selectedMode()).toContain('Auto (Pull and Push)');
  });

  test('a never-answered project rests in Manual', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: {} };
    await renderBadge();
    await openPopover();

    expect(selectedMode()).toContain('Manual');
    expect(screen.getByTestId('sync-popover-mode-line').textContent).toContain(
      'Nothing moves until you ask',
    );
  });

  test('mode selector is disabled until the project-local config has synced', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { enabled: false } };
    projectLocalSynced = false;
    await renderBadge();
    await openPopover();

    expect((screen.getByTestId('sync-mode-select') as HTMLButtonElement).disabled).toBe(true);
  });

  test('choosing an auto mode confirms before patching; Manual applies immediately', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByTestId('sync-mode-select'));
    await userEvent.click(screen.getByRole('option', { name: 'Auto (Pull and Push)' }));
    expect(patches).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Enable Auto (Pull and Push)' }));
    expect(patches).toEqual([{ autoSync: { mode: 'full', enabled: null, resumeMode: null } }]);
  });

  test('returning to Manual writes straight through — standing sync down never pushes', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'full' } };
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByTestId('sync-mode-select'));
    await userEvent.click(screen.getByRole('option', { name: 'Manual' }));

    expect(patches).toEqual([{ autoSync: { mode: 'off', enabled: null, resumeMode: null } }]);
  });

  test('conflicts gate Push but never Pull', async () => {
    status = { ...baseStatus, state: 'idle', conflictCount: 1 };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    expect((screen.getByTestId('sync-popover-pull') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('sync-popover-push') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sync-popover-sync') as HTMLButtonElement).disabled).toBe(true);
  });

  test('a real merge conflict blocks Pull, unlike a ledger conflict', async () => {
    status = { ...baseStatus, state: 'conflict', conflictCount: 1 };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    expect((screen.getByTestId('sync-popover-pull') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sync-popover-push') as HTMLButtonElement).disabled).toBe(true);
  });

  test('manual actions dispatch the matching one-shot op', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByTestId('sync-popover-pull'));
    await userEvent.click(screen.getByTestId('sync-popover-push'));
    await userEvent.click(screen.getByTestId('sync-popover-sync'));

    expect(triggered).toEqual(['pull', 'push', 'sync']);
  });

  test('the in-flight spinner lands on the action the user clicked', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByTestId('sync-popover-pull'));
    await advanceStatus({ ...baseStatus, state: 'pulling' });

    expect(spinnerIn('sync-popover-pull')).not.toBeNull();
    expect(spinnerIn('sync-popover-sync')).toBeNull();
    expect(spinnerIn('sync-popover-push')).toBeNull();

    await advanceStatus({ ...baseStatus, state: 'idle' });
    expect(spinnerIn('sync-popover-pull')).toBeNull();

    await userEvent.click(screen.getByTestId('sync-popover-push'));
    await advanceStatus({ ...baseStatus, state: 'pushing' });

    expect(spinnerIn('sync-popover-push')).not.toBeNull();
    expect(spinnerIn('sync-popover-sync')).toBeNull();
    expect(spinnerIn('sync-popover-pull')).toBeNull();
  });

  test('a trigger that never reaches the engine does not misattribute the next cycle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      status = { ...baseStatus, state: 'idle' };
      projectLocalConfig = { autoSync: { mode: 'full' } };
      await renderBadge();
      await openPopover();

      triggerRejection = new Error('offline');
      await userEvent.click(screen.getByTestId('sync-popover-pull'));
      await waitFor(() => expect(warn).toHaveBeenCalled());
      triggerRejection = null;

      expect(spinnerIn('sync-popover-pull')).toBeNull();

      await advanceStatus({ ...baseStatus, state: 'pushing' });
      expect(spinnerIn('sync-popover-push')).not.toBeNull();
      expect(spinnerIn('sync-popover-pull')).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    ['pulling', 'pulling', 'sync-popover-pull'],
    ['fetching', 'fetching', 'sync-popover-pull'],
    ['pushing', 'pushing', 'sync-popover-push'],
  ] as const)('an automation-driven %s cycle spins the matching direction, never Pull and Push', async (_label, state, expectedTestId) => {
    status = { ...baseStatus, state } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'full' } };
    await renderBadge();
    await openPopover();

    expect(spinnerIn(expectedTestId)).not.toBeNull();
    expect(spinnerIn('sync-popover-sync')).toBeNull();
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
    status = {
      ...baseStatus,
      syncMode: 'follow',
      state: 'disabled',
      pausedReason: undefined,
    } as GitSyncStatus;
    await renderBadge();

    expect(screen.getByRole('button', { name: /Sync status:/ })).toBeTruthy();
  });

  test('Follow still offers all three manual actions — the mode governs automation, not the user', async () => {
    status = { ...baseStatus, syncMode: 'follow', state: 'idle' } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    await renderBadge();
    await openPopover();

    expect(selectedMode()).toContain('Auto (Pull only)');
    expect(screen.getByTestId('sync-popover-pull')).toBeTruthy();
    expect(screen.getByTestId('sync-popover-push')).toBeTruthy();
    expect(screen.getByTestId('sync-popover-sync')).toBeTruthy();
  });

  test('a read-only collaborator is the one case that loses the push actions', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    await renderBadge();
    await openPopover();

    expect(screen.getByTestId('sync-popover-pull')).toBeTruthy();
    expect(screen.queryByTestId('sync-popover-push')).toBeNull();
    expect(screen.queryByTestId('sync-popover-sync')).toBeNull();
  });

  test('following popover keeps the mode selector usable when push is denied', async () => {
    status = {
      ...baseStatus,
      syncMode: 'follow',
      state: 'idle',
      pushPermission: { checkStatus: 'denied' },
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    await renderBadge();
    await openPopover();

    expect((screen.getByTestId('sync-mode-select') as HTMLButtonElement).disabled).toBe(false);
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

    expect(screen.getByTestId('sync-popover-mode-line').textContent).toContain(
      'Updates flow in from your remote',
    );
    expect(screen.queryByText(/don't have permission to push/)).toBeNull();
  });

  test('a read-only collaborator on full can still see which mode the project is in', async () => {
    status = {
      ...baseStatus,
      syncMode: 'full',
      state: 'idle',
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'full' } };
    await renderBadge();
    await openPopover();

    expect(selectedMode()).toContain('Auto (Pull and Push)');
  });

  test('a genuine read-only collaborator cannot choose a pushing mode', async () => {
    status = {
      ...baseStatus,
      syncMode: 'follow',
      state: 'idle',
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByTestId('sync-mode-select'));
    expect(screen.getByRole('option', { name: 'Manual' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Auto (Pull only)' })).toBeTruthy();
    const pushing = screen.getByRole('option', { name: 'Auto (Pull and Push)' });
    expect(pushing.getAttribute('aria-disabled')).toBe('true');
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

  test('a signed-out denial renders the reconnect line and its Sign in button', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      pushPermission: { checkStatus: 'denied', deniedReason: 'not-authenticated' },
    };
    await renderBadge({ onSignIn: () => {} });
    await openPopover();

    expect(screen.getByText(/signed out — sign in to resume syncing/)).toBeTruthy();
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect(signIn).toBeTruthy();
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
  });

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
    expect(screen.getByRole('button', { name: 'Sync status: Reconnect required' })).toBeTruthy();
    expect(screen.queryByText('Reconnect required')).toBeNull();
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
  });

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

    expect(screen.getByText(/don't have access to this private repo/)).toBeTruthy();
    expect(screen.getByText('Authenticated as bob.')).toBeTruthy();
    expect(
      screen.getByText(
        "Your remote URL names alice, but that account's credentials couldn't be used.",
      ),
    ).toBeTruthy();
  });

  test('a not-found-as-identity auth error withdraws the Sign in affordance', async () => {
    status = {
      ...baseStatus,
      state: 'auth-error',
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-not-found-as-identity',
    };
    await renderBadge({ onSignIn: () => {} });
    await openPopover();

    expect(screen.getByText(/Repository not found — it may not exist/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByText('Reconnect required')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync status: Repository not found' })).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });

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

    expect(screen.getByTestId('sync-mode-select')).toBeTruthy();
    expect(screen.getByText('Authenticated as bob.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByText(/Sign in with an account that does/)).toBeNull();
    expect(screen.queryByText(/don't have access to this private repo/)).toBeNull();
  });

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
    await renderBadge({ onSignIn: () => {} });
    await openPopover();

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getAllByText('Reconnect required').length).toBeGreaterThan(0);
  });

  test('a config left over from the old paused state reads as Manual', async () => {
    status = {
      ...baseStatus,
      state: 'disabled',
      syncMode: 'off',
      pausedReason: undefined,
      syncEnabled: false,
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off', resumeMode: 'full' } };
    await renderBadge();
    await openPopover();

    expect(selectedMode()).toContain('Manual');
    expect(screen.getByTestId('sync-popover-pull')).toBeTruthy();
    expect(screen.getByTestId('sync-popover-push')).toBeTruthy();
  });

  test('leaving Manual clears a stale resumeMode rather than carrying it forward', async () => {
    status = {
      ...baseStatus,
      state: 'disabled',
      syncMode: 'off',
      syncEnabled: false,
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off', resumeMode: 'full' } };
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByTestId('sync-mode-select'));
    await userEvent.click(screen.getByRole('option', { name: 'Auto (Pull only)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Enable Auto (Pull only)' }));

    expect(patches).toEqual([{ autoSync: { mode: 'follow', enabled: null, resumeMode: null } }]);
  });

  test('a pre-merge overlap gets the resolution panel, not the paused sentence', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      pausedReason: 'external-changes-pending',
      blockingPaths: ['.claude/launch.json', '.vscode/settings.json'],
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    expect(screen.getByTestId('sync-blocking-commit')).toBeTruthy();
    expect(screen.queryByTestId('sync-blocking-discard')).toBeNull();
    expect(screen.getByText('.claude/launch.json')).toBeTruthy();
  });

  test('a paused reason with no actionable paths keeps the explanatory line', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      pausedReason: 'diverged-local-commits',
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    expect(screen.queryByTestId('sync-blocking-commit')).toBeNull();
  });

  test('the manual actions are offered to a never-enabled project', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      syncMode: 'off',
      syncEnabled: false,
    } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    expect(screen.getByTestId('sync-popover-pull')).toBeTruthy();
    expect(screen.getByTestId('sync-popover-push')).toBeTruthy();
    expect(screen.getByTestId('sync-popover-sync')).toBeTruthy();
  });
});

describe('SyncStatusBadge working-tree listing', () => {
  afterEach(() => {
    cleanup();
    status = null;
    projectLocalConfig = { autoSync: { enabled: false } };
    projectLocalSynced = true;
    patches.length = 0;
    worktree = emptyWorktree;
    triggered.length = 0;
    triggerRejection = null;
  });

  test("groups by what Push will do, not by git's index state", async () => {
    status = { ...baseStatus, state: 'idle', ahead: 1, behind: 2 };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      staged: [{ path: 'docs/sync.mdx', code: 'M', syncScoped: true }],
      notStaged: [{ path: 'src/git/status.ts', code: 'M', syncScoped: false }],
      untracked: [{ path: 'notes/cadence-draft.md', code: '?', syncScoped: true }],
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    expect(screen.getByText('Push includes')).toBeTruthy();
    expect(screen.getByText('Push skips')).toBeTruthy();
    expect(screen.queryByText('Staged')).toBeNull();
    expect(screen.queryByText('Not staged')).toBeNull();

    const listing = within(screen.getByTestId('worktree-listing'));
    expect(listing.getByText('docs/sync.mdx', { selector: 'span:not(.sr-only)' })).toBeTruthy();
    expect(
      listing.getByText('notes/cadence-draft.md', { selector: 'span:not(.sr-only)' }),
    ).toBeTruthy();
    expect(listing.getByText('src/git/status.ts', { selector: 'span:not(.sr-only)' })).toBeTruthy();
    expect(screen.getByText(/Outside what Open Knowledge commits/)).toBeTruthy();

    expect(screen.getByText('2 behind')).toBeTruthy();
    expect(screen.getByText('1 ahead')).toBeTruthy();
    expect(screen.getByText('main → origin/main')).toBeTruthy();
  });

  test('a row opens what the sidebar would: docs to the doc route, the rest to the asset viewer', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: [
        {
          path: 'notes/cadence.md',
          code: 'M',
          syncScoped: true,
          open: { kind: 'doc', docName: 'notes/cadence' },
        },
        {
          path: 'opencode.json',
          code: 'M',
          syncScoped: true,
          open: { kind: 'asset', path: 'opencode.json' },
        },
        { path: 'notes/gone.md', code: 'D', syncScoped: true },
      ],
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    await userEvent.click(screen.getByRole('button', { name: 'opencode.json' }));
    expect(window.location.hash).toBe('#/__asset__/opencode.json');

    await openPopover();
    await expandWorktreeListing();
    expect(screen.queryByRole('button', { name: 'gone.md' })).toBeNull();
    expect(screen.getByText('gone.md')).toBeTruthy();
    const listing = within(screen.getByTestId('worktree-listing'));
    expect(listing.getByText('notes/gone.md', { selector: '.sr-only' })).toBeTruthy();

    const rowClasses = screen.getAllByTestId('worktree-row-open')[0].className.split(' ');
    expect(rowClasses).toContain('shrink');
    expect(rowClasses).not.toContain('shrink-0');

    const cadenceBtn = screen.getByRole('button', { name: 'notes/cadence.md' });
    expect(cadenceBtn.textContent).toContain('cadence.md');
    await userEvent.click(cadenceBtn);

    expect(window.location.hash).toBe('#/notes/cadence');
    await waitFor(() => {
      expect(screen.queryByTestId('sync-mode-select')).toBeNull();
    });
  });

  test('a folder header resolves the full path, not the label it already shows', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: ['ar', 'bn'].flatMap((l) => [
        { path: `app/src/locales/${l}/messages.po`, code: 'M' as const, syncScoped: true },
        { path: `app/src/locales/${l}/messages.json`, code: 'M' as const, syncScoped: true },
      ]),
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    const listing = within(screen.getByTestId('worktree-listing'));
    const header = listing.getByRole('button', { name: /^ar/ });
    expect(header.textContent).toContain('ar');
    expect(header.textContent).not.toContain('app/src/locales');

    (document.activeElement as HTMLElement | null)?.blur();
    header.focus();
    expect(document.activeElement).toBe(header);
    await waitFor(() => {
      expect(screen.getAllByText('app/src/locales/ar').length).toBeGreaterThan(0);
    });
  });

  test('a non-linking row is reachable by keyboard and its focus opens the full path', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: [
        { path: 'notes/kept.md', code: 'M', syncScoped: true },
        { path: 'notes/gone.md', code: 'D', syncScoped: true },
      ],
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    const listing = within(screen.getByTestId('worktree-listing'));
    const label = listing.getByText('gone.md', { selector: 'span:not(.sr-only)' });
    expect(label.tagName).toBe('SPAN');

    expect(screen.queryByRole('tooltip')).toBeNull();

    (document.activeElement as HTMLElement | null)?.blur();
    label.focus();
    expect(document.activeElement).toBe(label);

    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain('notes/gone.md');
    });
  });

  test('an ungrouped row omits the sr-only fallback rather than repeating itself', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: [{ path: 'notes/solo.md', code: 'D', syncScoped: true }],
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    const listing = within(screen.getByTestId('worktree-listing'));
    expect(listing.getByText('notes/solo.md')).toBeTruthy();
    expect(listing.queryByText('notes/solo.md', { selector: '.sr-only' })).toBeNull();
  });

  test('clickability follows the document, not the group the row landed in', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: [
        {
          path: 'notes/private.md',
          code: 'M',
          syncScoped: false,
          open: { kind: 'doc', docName: 'notes/private' },
        },
      ],
      incoming: [
        {
          path: 'notes/from-remote.md',
          code: 'M',
          syncScoped: true,
          open: { kind: 'doc', docName: 'notes/from-remote' },
        },
      ],
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    expect(screen.getByText('Push skips')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'notes/private.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'notes/from-remote.md' })).toBeTruthy();
  });

  test('an all-in-scope listing never shows the skipped group', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: [{ path: 'docs/sync.mdx', code: 'M', syncScoped: true }],
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    expect(screen.getByText('Push includes')).toBeTruthy();
    expect(screen.queryByText('Push skips')).toBeNull();
    expect(screen.queryByText(/Outside what Open Knowledge commits/)).toBeNull();
  });

  test('a path dirty in both columns renders once, keeping the index letter', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      staged: [{ path: 'docs/sync.mdx', code: 'A', syncScoped: true }],
      notStaged: [{ path: 'docs/sync.mdx', code: 'M', syncScoped: true }],
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    expect(
      within(screen.getByTestId('worktree-listing')).getAllByText('docs/sync.mdx', {
        selector: 'span:not(.sr-only)',
      }),
    ).toHaveLength(1);
    expect(screen.getByText('A')).toBeTruthy();
  });

  test('a tree that could not be read never claims to be clean', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = { ...emptyWorktree, readable: false };
    await renderBadge();
    await openPopover();

    expect(screen.queryByText(/working tree clean/)).toBeNull();
    expect(screen.getByTestId('worktree-unreadable')).toBeTruthy();
  });

  test('a clean tree says so instead of rendering empty groups', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = emptyWorktree;
    await renderBadge();
    await openPopover();

    expect(screen.getByText(/working tree clean/)).toBeTruthy();
    expect(screen.queryByText('Staged')).toBeNull();
  });

  test('a truncated listing says files are missing rather than implying completeness', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      untracked: [{ path: 'a.md', code: '?', syncScoped: true }],
      truncated: true,
    };
    await renderBadge();
    await openPopover();

    expect(screen.getByText(/too many changes/)).toBeTruthy();
  });

  test('shows what a pull would bring in, above what a push would send', async () => {
    status = { ...baseStatus, state: 'idle', behind: 1 };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      incoming: [{ path: 'notes/from-teammate.md', code: 'A', syncScoped: true }],
      notStaged: [{ path: 'notes/mine.md', code: 'M', syncScoped: true }],
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    expect(screen.getByText('Pull brings in')).toBeTruthy();
    expect(
      within(screen.getByTestId('worktree-listing')).getByText('notes/from-teammate.md', {
        selector: 'span:not(.sr-only)',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Push includes')).toBeTruthy();
    expect(
      within(screen.getByTestId('worktree-listing')).getByText('notes/mine.md', {
        selector: 'span:not(.sr-only)',
      }),
    ).toBeTruthy();
  });

  test('an up-to-date remote shows no incoming group', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: [{ path: 'notes/mine.md', code: 'M', syncScoped: true }],
    };
    await renderBadge();
    await openPopover();

    expect(screen.queryByText('Pull brings in')).toBeNull();
  });

  test('incoming-only is not a clean tree', async () => {
    status = { ...baseStatus, state: 'idle', behind: 2 };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      incoming: [{ path: 'notes/from-teammate.md', code: 'M', syncScoped: true }],
    };
    await renderBadge();
    await openPopover();

    expect(screen.queryByText(/working tree clean/)).toBeNull();
    expect(screen.getByText('Pull brings in')).toBeTruthy();
  });

  test('"Updated" tracks the last sync RUN, not the last content change', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      lastSyncUtc: new Date(Date.now() - 18 * 3_600_000).toISOString(),
      lastRunUtc: new Date().toISOString(),
    };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    const line = screen.getByTestId('sync-popover-last-sync').textContent ?? '';
    expect(line).toContain('Updated');
    expect(line).toContain('now');
  });

  test('never sources "Updated" from the fetch time', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      lastRunUtc: null,
      lastFetchUtc: new Date().toISOString(),
      lastSyncUtc: new Date(Date.now() - 18 * 3_600_000).toISOString(),
    };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    const line = screen.getByTestId('sync-popover-last-sync').textContent ?? '';
    expect(line).toContain('18h');
    expect(line).not.toContain('now');
  });

  test('hides the line entirely when nothing has ever synced', async () => {
    status = {
      ...baseStatus,
      state: 'idle',
      lastRunUtc: null,
      lastFetchUtc: new Date().toISOString(),
      lastSyncUtc: null,
    };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    await renderBadge();
    await openPopover();

    expect(screen.queryByTestId('sync-popover-last-sync')).toBeNull();
  });

  test('a detached HEAD is named rather than rendered as a branch', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = { ...emptyWorktree, branch: null, detached: true, upstream: null };
    await renderBadge();
    await openPopover();

    expect(screen.getByText('detached HEAD')).toBeTruthy();
  });

  test('a row list with more than the cap shows only the cap and an overflow button', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: Array.from({ length: 7 }, (_, i) => ({
        path: `notes/file-${i}.md`,
        code: 'M',
        syncScoped: true,
        open: { kind: 'doc' as const, docName: `notes/file-${i}` },
      })),
    };
    await renderBadge();
    await openPopover();
    await userEvent.click(screen.getByRole('button', { name: /Push includes/ }));

    expect(screen.getByTestId('worktree-rows-show-all')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'notes/file-6.md' })).toBeNull();
  });

  test('a row list at or below the cap shows all entries without an overflow button', async () => {
    status = { ...baseStatus, state: 'idle' };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    worktree = {
      ...emptyWorktree,
      notStaged: Array.from({ length: 6 }, (_, i) => ({
        path: `notes/file-${i}.md`,
        code: 'M',
        syncScoped: true,
        open: { kind: 'doc' as const, docName: `notes/file-${i}` },
      })),
    };
    await renderBadge();
    await openPopover();
    await expandWorktreeListing();

    expect(screen.queryByTestId('worktree-rows-show-all')).toBeNull();
    expect(screen.getByRole('button', { name: 'notes/file-0.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'notes/file-5.md' })).toBeTruthy();
  });
});

describe('SyncStatusBadge settings affordance', () => {
  beforeEach(() => {
    settingsNavigations = [];
    status = { ...baseStatus, lastRunUtc: new Date().toISOString() } as GitSyncStatus;
    projectLocalConfig = { autoSync: { mode: 'full' } };
  });

  afterEach(() => {
    cleanup();
    status = null;
    projectLocalConfig = { autoSync: { enabled: false } };
  });

  test('the popover offers a way into the Sync settings section', async () => {
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByTestId('sync-popover-settings'));

    expect(settingsNavigations).toEqual(['sync']);
  });

  test('choosing Settings closes the popover', async () => {
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByTestId('sync-popover-settings'));

    await waitFor(() => {
      expect(screen.queryByTestId('sync-mode-select')).toBeNull();
    });
  });

  test('the settings link is present before the first cycle, when no freshness line is', async () => {
    status = { ...baseStatus, lastRunUtc: null, lastSyncUtc: null } as GitSyncStatus;

    await renderBadge();
    await openPopover();

    expect(screen.queryByTestId('sync-popover-last-sync')).toBeNull();
    expect(screen.queryByTestId('sync-popover-settings')).not.toBeNull();
  });
});

describe('SyncStatusBadge freshness line', () => {
  const AT_2_MIN = new Date(Date.now() - 2 * 60_000).toISOString();
  const AT_5_MIN = new Date(Date.now() - 5 * 60_000).toISOString();

  afterEach(() => {
    cleanup();
    status = null;
  });

  function freshnessLabel(): string {
    return (
      screen.queryByTestId('sync-popover-last-sync-label')?.textContent ??
      screen.getByTestId('sync-popover-last-sync').textContent ??
      ''
    );
  }

  function freshnessVisual(): string {
    return (
      screen.getByTestId('sync-popover-last-sync').textContent?.replace(freshnessLabel(), '') ?? ''
    );
  }

  test('reports the two directions separately when both have run', async () => {
    status = {
      ...baseStatus,
      lastPullOkUtc: AT_2_MIN,
      lastPushOkUtc: AT_5_MIN,
    } as GitSyncStatus;

    await renderBadge();
    await openPopover();

    expect(freshnessLabel()).toBe('Pulled 2m ago · pushed 5m ago');
    expect(freshnessVisual()).toContain('2m');
    expect(freshnessVisual()).toContain('5m');
    expect(freshnessVisual()).not.toContain('Pulled');
  });

  test('a project that has only pulled shows one half, not "pushed never"', async () => {
    status = { ...baseStatus, lastPullOkUtc: AT_2_MIN, lastPushOkUtc: null } as GitSyncStatus;

    await renderBadge();
    await openPopover();

    expect(freshnessLabel()).toBe('Pulled 2m ago');
  });

  test('a project that has only pushed shows the push half', async () => {
    status = { ...baseStatus, lastPullOkUtc: null, lastPushOkUtc: AT_5_MIN } as GitSyncStatus;

    await renderBadge();
    await openPopover();

    expect(freshnessLabel()).toBe('Pushed 5m ago');
  });

  test('an engine without the split falls back to direction-blind wording', async () => {
    status = { ...baseStatus, lastRunUtc: AT_2_MIN } as GitSyncStatus;

    await renderBadge();
    await openPopover();

    expect(freshnessLabel()).toBe('Updated 2m ago');
  });

  test('a project that has never run shows no freshness line but keeps the footer link', async () => {
    status = {
      ...baseStatus,
      lastRunUtc: null,
      lastSyncUtc: null,
      lastPullOkUtc: null,
      lastPushOkUtc: null,
    } as GitSyncStatus;

    await renderBadge();
    await openPopover();

    expect(screen.queryByTestId('sync-popover-last-sync')).toBeNull();
    expect(screen.queryByTestId('sync-popover-settings')).not.toBeNull();
  });
});
