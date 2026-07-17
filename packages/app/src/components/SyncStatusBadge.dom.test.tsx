import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  plural: (value: number, options: { one: string; other: string }) =>
    (value === 1 ? options.one : options.other).replace('#', String(value)),
}));

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

let status: GitSyncStatus | null = null;
let fetchError: 'network' | 'server' | null = null;
let projectLocalConfig: { autoSync?: { enabled?: boolean | null } } | null = {
  autoSync: { enabled: false },
};
let projectLocalSynced = true;
const patches: unknown[] = [];

mock.module('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({ status, fetchError }),
}));

mock.module('@/hooks/use-conflicts', () => ({
  useConflicts: () => ({ conflicts: [{ file: 'docs/conflicted.md' }] }),
}));

mock.module('@/lib/config-provider', () => ({
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
    expect(shouldOfferSignInAgain(undefined)).toBe(false);
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

  test('popover switch checked state reads local config, not server syncEnabled', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { enabled: true } };
    await renderBadge();
    await openPopover();

    const toggle = screen.getByRole('switch', { name: 'Disable sync' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  test('popover switch is disabled until the project-local config has synced', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { enabled: false } };
    projectLocalSynced = false;
    await renderBadge();
    await openPopover();

    const toggle = screen.getByRole('switch', { name: 'Enable sync' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });

  test('off to on opens confirmation before patching project-local config', async () => {
    status = { ...baseStatus, state: 'idle', syncEnabled: false };
    projectLocalConfig = { autoSync: { enabled: false } };
    await renderBadge();
    await openPopover();

    await userEvent.click(screen.getByRole('switch', { name: 'Enable sync' }));
    expect(patches).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Enable auto-sync' }));
    expect(patches).toEqual([{ autoSync: { enabled: true } }]);
  });
});
