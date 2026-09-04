import type { ShareTargetStatusResponse } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { missDialogStore } from '@/lib/share/miss-dialog-store';
import { pendingReceiveNavStore } from '@/lib/share/pending-receive-nav-store';

type AutoSyncPatch = { mode?: string; enabled?: boolean | null };
let autoSyncWrites: AutoSyncPatch[] = [];
let configPatchResult: { ok: true } | { ok: false; error: { code: string; message: string } } = {
  ok: true,
};
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalBinding: {
      patch: (value: { autoSync?: AutoSyncPatch }) => {
        if (value.autoSync !== undefined) autoSyncWrites.push(value.autoSync);
        return configPatchResult;
      },
    },
  }),
}));

let syncStatus: GitSyncStatus | null = null;
const syncStatusListeners = new Set<() => void>();
function setSyncStatus(next: GitSyncStatus | null): void {
  syncStatus = next;
  for (const listener of syncStatusListeners) listener();
}
vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () =>
    useSyncExternalStore(
      (onStoreChange: () => void) => {
        syncStatusListeners.add(onStoreChange);
        return () => syncStatusListeners.delete(onStoreChange);
      },
      () => syncStatus,
    ),
  useGitSyncStatusDetailed: () => ({ status: syncStatus, fetchError: null }),
}));

let syncTriggers: string[] = [];
let triggerSyncImpl: () => Promise<void> = () => Promise.resolve();
vi.doMock('@/lib/trigger-sync', () => ({
  triggerSync: (op: string) => {
    syncTriggers.push(op);
    return triggerSyncImpl();
  },
}));

function makeSyncStatus(partial: Partial<GitSyncStatus>): GitSyncStatus {
  return {
    state: 'idle',
    lastSyncUtc: '2026-07-06T00:00:00Z',
    lastFetchUtc: null,
    ahead: 0,
    behind: 0,
    conflictCount: 0,
    hasRemote: true,
    syncEnabled: true,
    ...partial,
  };
}

function pullableSyncStatus(partial: Partial<GitSyncStatus> = {}): GitSyncStatus {
  return makeSyncStatus({
    syncEnabled: false,
    state: 'disabled',
    lastPullUtc: 'p0',
    lastPullOutcome: null,
    ...partial,
  });
}

function syncingPullableStatus(partial: Partial<GitSyncStatus> = {}): GitSyncStatus {
  return pullableSyncStatus({ syncEnabled: true, state: 'idle', ...partial });
}

const { ShareReceiveMissDialog } = await import('./ShareReceiveMissDialog');
const { __resetFollowOfferLatchForTests } = await import('./share-receive-miss-content');

type FetchTargetStatus = (req: {
  projectPath: string;
  branch: string;
  path: string;
  kind: 'doc' | 'folder';
}) => Promise<ShareTargetStatusResponse | null>;

function installBridge(fetchTargetStatus: FetchTargetStatus): void {
  (window as { okDesktop?: unknown }).okDesktop = {
    config: { projectPath: '/tmp/project' },
    project: { fetchTargetStatus },
  };
}

function stubVerdict(response: ShareTargetStatusResponse | null): FetchTargetStatus {
  return () => Promise.resolve(response);
}

const DOC_NAV = { kind: 'doc' as const, path: 'notes/plan.md', branch: 'feature' };

function openConsentDialog(): HTMLElement {
  const consent = screen
    .getAllByRole('dialog')
    .find((d) => d.getAttribute('data-testid') !== 'share-receive-miss-dialog');
  if (!consent) throw new Error('consent dialog not found');
  return consent;
}

async function renderArmed(nav = DOC_NAV): Promise<HTMLElement> {
  render(<ShareReceiveMissDialog />);
  missDialogStore.arm(nav);
  const dialog = await screen.findByTestId('share-receive-miss-dialog');
  await screen.findByText((_, el) => el?.getAttribute('data-phase') === 'resolved');
  return dialog;
}

beforeEach(() => {
  cleanup();
  window.location.hash = '';
  missDialogStore.dismiss();
  pendingReceiveNavStore.clear();
  __resetFollowOfferLatchForTests();
});
afterEach(() => {
  cleanup();
  missDialogStore.dismiss();
  pendingReceiveNavStore.clear();
  Reflect.deleteProperty(window, 'okDesktop');
  autoSyncWrites = [];
  configPatchResult = { ok: true };
  syncTriggers = [];
  triggerSyncImpl = () => Promise.resolve();
  syncStatus = null;
  syncStatusListeners.clear();
});

describe('ShareReceiveMissDialog', () => {
  test('renders nothing until the store is armed', () => {
    installBridge(stubVerdict({ verdict: 'deleted' }));
    render(<ShareReceiveMissDialog />);
    expect(screen.queryByTestId('share-receive-miss-dialog')).toBeNull();
  });

  test('deleted verdict shows the honest removed message titled by the target', async () => {
    installBridge(stubVerdict({ verdict: 'deleted' }));
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('deleted');
    expect(dialog.textContent).toContain('was removed from branch');
    expect(dialog.textContent).toContain('feature');
    expect(dialog.textContent).toContain('plan.md');
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
    expect(screen.queryByTestId('share-receive-miss-open-renamed')).toBeNull();
  });

  test('renamed verdict offers the redirect', async () => {
    installBridge(stubVerdict({ verdict: 'renamed', renamedTo: 'knowledge/new-plan.md' }));
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('renamed');
    expect(dialog.textContent).toContain('moved to');
    expect(dialog.textContent).toContain('knowledge/new-plan.md');
  });

  test('changed-locally: Enable auto-sync enables in place and dismisses the dialog', async () => {
    installBridge(stubVerdict({ verdict: 'changed-locally' }));
    setSyncStatus(makeSyncStatus({ syncEnabled: false, state: 'disabled' }));
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('changed-locally');
    expect(dialog.textContent).toContain('has been moved, renamed, or deleted');
    expect(screen.queryByTestId('share-receive-miss-sync-now')).toBeNull();

    fireEvent.click(screen.getByTestId('share-receive-miss-enable-sync'));
    fireEvent.click(
      within(openConsentDialog()).getByRole('button', { name: 'Enable Auto (Pull and Push)' }),
    );

    expect(autoSyncWrites).toEqual([{ mode: 'full', enabled: true }]);
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
  });

  test('changed-locally with auto-sync ON offers Sync now; a landed sync re-probes to the honest verdict', async () => {
    const verdicts: ShareTargetStatusResponse[] = [
      { verdict: 'changed-locally' },
      { verdict: 'renamed', renamedTo: 'knowledge/new-plan.md' },
    ];
    let probeCount = 0;
    installBridge(() => Promise.resolve(verdicts[Math.min(probeCount++, verdicts.length - 1)]));
    setSyncStatus(makeSyncStatus({ syncEnabled: true, lastSyncUtc: 't0' }));
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('changed-locally');
    expect(dialog.textContent).toContain("hasn't synced yet");
    expect(screen.queryByTestId('share-receive-miss-enable-sync')).toBeNull();

    expect(screen.getByTestId('share-receive-miss-sync-status').textContent).toBe('');

    fireEvent.click(screen.getByTestId('share-receive-miss-sync-now'));
    expect(syncTriggers).toEqual(['sync']);
    expect((screen.getByTestId('share-receive-miss-sync-now') as HTMLButtonElement).disabled).toBe(
      true,
    );
    const syncStatusRegion = screen.getByTestId('share-receive-miss-sync-status');
    expect(syncStatusRegion.getAttribute('role')).toBe('status');
    expect(syncStatusRegion.textContent).toBe('Syncing your changes');

    setSyncStatus(makeSyncStatus({ syncEnabled: true, lastSyncUtc: 't1' }));
    await waitFor(() => {
      expect(dialog.getAttribute('data-verdict')).toBe('renamed');
    });
    expect(screen.getByTestId('share-receive-miss-open-renamed')).toBeTruthy();
    expect(probeCount).toBe(2);
  });

  test('changed-locally with auto-sync ON but a failing push defers to the sync badge (no sync CTA)', async () => {
    installBridge(stubVerdict({ verdict: 'changed-locally' }));
    setSyncStatus(makeSyncStatus({ syncEnabled: true, pushError: 'push failed' }));
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('changed-locally');
    expect(screen.queryByTestId('share-receive-miss-sync-now')).toBeNull();
    expect(screen.queryByTestId('share-receive-miss-enable-sync')).toBeNull();
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
  });

  test('changed-locally with auto-sync ON but push permission denied defers to the sync badge (no sync CTA)', async () => {
    installBridge(stubVerdict({ verdict: 'changed-locally' }));
    setSyncStatus(
      makeSyncStatus({
        syncEnabled: true,
        pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
      }),
    );
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('changed-locally');
    expect(screen.queryByTestId('share-receive-miss-sync-now')).toBeNull();
    expect(screen.queryByTestId('share-receive-miss-enable-sync')).toBeNull();
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
  });

  test('Sync now recovers to an enabled button when the trigger itself fails', async () => {
    installBridge(stubVerdict({ verdict: 'changed-locally' }));
    setSyncStatus(makeSyncStatus({ syncEnabled: true }));
    triggerSyncImpl = () => Promise.reject(new Error('server down'));
    const dialog = await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-sync-now'));
    expect(syncTriggers).toEqual(['sync']);

    await waitFor(() => {
      expect(
        (screen.getByTestId('share-receive-miss-sync-now') as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(dialog.getAttribute('data-verdict')).toBe('changed-locally');
  });

  test('changed-locally with an unknown sync state renders neither sync CTA', async () => {
    installBridge(stubVerdict({ verdict: 'changed-locally' }));
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('changed-locally');
    expect(screen.queryByTestId('share-receive-miss-sync-now')).toBeNull();
    expect(screen.queryByTestId('share-receive-miss-enable-sync')).toBeNull();
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
  });

  test('browse folder navigates to the parent folder and dismisses — never to the dead path', async () => {
    installBridge(stubVerdict({ verdict: 'deleted' }));
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-browse'));

    expect(window.location.hash).toBe('#/notes/');
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
  });

  test('accepting the rename navigates to the redirect, arms the backstop, and dismisses', async () => {
    installBridge(stubVerdict({ verdict: 'renamed', renamedTo: 'knowledge/new-plan.md' }));
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-open-renamed'));

    expect(window.location.hash).toBe('#/knowledge/new-plan.md');
    expect(pendingReceiveNavStore.getSnapshot()).toEqual({
      kind: 'doc',
      path: 'knowledge/new-plan.md',
      repositoryPath: 'knowledge/new-plan.md',
      branch: 'feature',
    });
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
  });

  test('a failed target-status fetch falls back to pull guidance (fail-open)', async () => {
    installBridge(stubVerdict(null));
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('unknown');
    expect(dialog.textContent).toContain('behind');
  });

  test('folder-share copy substitutes the folder noun', async () => {
    installBridge(stubVerdict({ verdict: 'deleted' }));
    const dialog = await renderArmed({ kind: 'folder', path: 'docs/guides', branch: 'feature' });

    expect(dialog.textContent).toContain('This folder was removed');
  });
});

describe('ShareReceiveMissDialog pull recovery', () => {
  test('a behind receiver on a pull-capable engine is offered Pull latest changes', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('on-origin');
    expect(screen.getByTestId('share-receive-miss-pull-now')).toBeTruthy();
    expect(dialog.textContent).toContain('is behind');
    expect(dialog.textContent).not.toContain('then open the link again');
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
  });

  test('the fail-open unknown verdict offers the same pull recovery', async () => {
    installBridge(stubVerdict(null));
    setSyncStatus(pullableSyncStatus());
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('unknown');
    expect(screen.getByTestId('share-receive-miss-pull-now')).toBeTruthy();
  });

  test('no pull CTA before the first sync-status response', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    const dialog = await renderArmed();

    expect(screen.queryByTestId('share-receive-miss-pull-now')).toBeNull();
    expect(dialog.textContent).toContain('Pull the latest changes, then open the link again');
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
  });

  test('no pull CTA without a remote to pull from', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus({ hasRemote: false }));
    const dialog = await renderArmed();

    expect(screen.queryByTestId('share-receive-miss-pull-now')).toBeNull();
    expect(dialog.textContent).toContain('Pull the latest changes, then open the link again');
  });

  test('no pull CTA while the engine is conflicted', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus({ state: 'conflict', conflictCount: 2 }));
    const dialog = await renderArmed();

    expect(screen.queryByTestId('share-receive-miss-pull-now')).toBeNull();
    expect(dialog.textContent).toContain('Pull the latest changes, then open the link again');
  });

  test('no pull CTA when the engine predates the pull-outcome contract', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(makeSyncStatus({ syncEnabled: false, state: 'disabled' }));
    const dialog = await renderArmed();

    expect(screen.queryByTestId('share-receive-miss-pull-now')).toBeNull();
    expect(dialog.textContent).toContain('Pull the latest changes, then open the link again');
  });

  test('clicking Pull triggers a one-shot pull and holds an in-flight state', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));

    expect(syncTriggers).toEqual(['pull']);
    const button = screen.getByTestId('share-receive-miss-pull-now') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Pulling');
    expect(missDialogStore.getSnapshot()).not.toBeNull();
  });

  test('a succeeded pull arms the backstop, opens the target, and dismisses', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(syncingPullableStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(syncingPullableStatus({ lastPullUtc: 'p1', lastPullOutcome: 'succeeded' }));

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/notes/plan.md');
    expect(pendingReceiveNavStore.getSnapshot()).toEqual({
      kind: 'doc',
      path: 'notes/plan.md',
      repositoryPath: 'notes/plan.md',
      branch: 'feature',
    });
  });

  test('an up-to-date pull resolves the flow the same way for a folder share', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(syncingPullableStatus());
    await renderArmed({ kind: 'folder', path: 'docs/guides', branch: 'feature' });

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(syncingPullableStatus({ lastPullUtc: 'p1', lastPullOutcome: 'up-to-date' }));

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/docs/guides/');
    expect(pendingReceiveNavStore.getSnapshot()).toEqual({
      kind: 'folder',
      path: 'docs/guides',
      repositoryPath: 'docs/guides',
      branch: 'feature',
    });
  });

  test('a conflict outcome opens the target without claiming the pull failed', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'conflict' }));

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/notes/plan.md');
    expect(screen.queryByTestId('share-receive-miss-pull-error')).toBeNull();
  });

  test('a refused pull explains the engine is busy and stays retriable', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'refused' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-receive-miss-pull-error').textContent).toContain(
        'Another sync operation is in progress',
      );
    });
    expect(missDialogStore.getSnapshot()).not.toBeNull();
    const button = screen.getByTestId('share-receive-miss-pull-now') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    expect(syncTriggers).toEqual(['pull', 'pull']);
    expect(screen.getByTestId('share-receive-miss-pull-error').textContent).toBe('');
  });

  test('an errored pull points at connectivity and stays retriable', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'error' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-receive-miss-pull-error').textContent).toContain(
        'Check your connection',
      );
    });
    expect(missDialogStore.getSnapshot()).not.toBeNull();
    expect((screen.getByTestId('share-receive-miss-pull-now') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test('a pull trigger that never lands clears the in-flight state', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    triggerSyncImpl = () => Promise.reject(new Error('server down'));
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));

    await waitFor(() => {
      expect(screen.getByTestId('share-receive-miss-pull-error').textContent).toContain(
        'Check your connection',
      );
    });
    expect((screen.getByTestId('share-receive-miss-pull-now') as HTMLButtonElement).disabled).toBe(
      false,
    );

    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'bg1', lastPullOutcome: 'succeeded' }));
    expect(missDialogStore.getSnapshot()).not.toBeNull();
    expect(window.location.hash).toBe('');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByTestId('share-receive-miss-pull-error').textContent).toContain(
      'Check your connection',
    );
  });

  test('completion is read off lastPullUtc, not lastSyncUtc', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(syncingPullableStatus({ lastSyncUtc: 's0' }));
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));

    setSyncStatus(syncingPullableStatus({ lastSyncUtc: 's1' }));
    await waitFor(() => {
      expect(
        (screen.getByTestId('share-receive-miss-pull-now') as HTMLButtonElement).textContent,
      ).toContain('Pulling');
    });
    expect(missDialogStore.getSnapshot()).not.toBeNull();

    setSyncStatus(
      syncingPullableStatus({
        lastSyncUtc: 's1',
        lastPullUtc: 'p1',
        lastPullOutcome: 'up-to-date',
      }),
    );
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
  });
});

describe('ShareReceiveMissDialog follow-mode offer', () => {
  test('a landed pull offers to keep the copy updated before opening the target', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'succeeded' }));

    const consent = await waitFor(() => openConsentDialog());
    expect(window.location.hash).toBe('');
    expect(autoSyncWrites).toEqual([]);

    fireEvent.click(within(consent).getByRole('button', { name: 'Enable Auto (Pull only)' }));

    expect(autoSyncWrites).toEqual([{ mode: 'follow', enabled: null }]);
    expect(syncTriggers).toEqual(['pull']);
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/notes/plan.md');
  });

  test('an up-to-date pull on a sync-off receiver still offers to keep the copy updated', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'up-to-date' }));

    const consent = await waitFor(() => openConsentDialog());
    expect(window.location.hash).toBe('');

    fireEvent.click(within(consent).getByRole('button', { name: 'Cancel' }));
    expect(autoSyncWrites).toEqual([]);
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/notes/plan.md');
  });

  test('nothing competes with the pull action before a pull has run', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    expect(screen.getByTestId('share-receive-miss-pull-now')).toBeTruthy();
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
    expect(screen.queryByTestId('share-receive-miss-keep-updated')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  test('declining the offer writes nothing and still opens the target', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'succeeded' }));

    const consent = await waitFor(() => openConsentDialog());
    fireEvent.click(within(consent).getByRole('button', { name: 'Cancel' }));

    expect(autoSyncWrites).toEqual([]);
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/notes/plan.md');
  });

  test('a rejected mode write still opens the target', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    configPatchResult = { ok: false, error: { code: 'WRITE_FAILED', message: 'binding offline' } };
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'succeeded' }));

    const consent = await waitFor(() => openConsentDialog());
    fireEvent.click(within(consent).getByRole('button', { name: 'Enable Auto (Pull only)' }));

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/notes/plan.md');
  });

  test('a conflicted pull heads for the resolver instead of the offer', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'conflict' }));

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/notes/plan.md');
    expect(autoSyncWrites).toEqual([]);
  });

  test('a failed pull reports the failure instead of offering follow', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'refused' }));

    await waitFor(() => {
      expect(screen.getByTestId('share-receive-miss-pull-error').textContent).not.toBe('');
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(autoSyncWrites).toEqual([]);
  });

  test('a receiver who already syncs is never asked to enable what they have', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(syncingPullableStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(syncingPullableStatus({ lastPullUtc: 'p1', lastPullOutcome: 'succeeded' }));

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(autoSyncWrites).toEqual([]);
  });

  test('the offer is made at most once per session', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'succeeded' }));
    const consent = await waitFor(() => openConsentDialog());
    fireEvent.click(within(consent).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });

    missDialogStore.arm(DOC_NAV);
    await screen.findByTestId('share-receive-miss-dialog');
    await screen.findByText((_, el) => el?.getAttribute('data-phase') === 'resolved');
    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p2', lastPullOutcome: 'succeeded' }));

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(autoSyncWrites).toEqual([]);
    expect(syncTriggers).toEqual(['pull', 'pull']);
  });

  test('the offer discloses commits follow mode would strand', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus({ ahead: 3 }));
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(
      pullableSyncStatus({ ahead: 3, lastPullUtc: 'p1', lastPullOutcome: 'succeeded' }),
    );

    const consent = await waitFor(() => openConsentDialog());
    expect(within(consent).getByText(/3 changes you haven't shared/)).toBeTruthy();
  });
});

describe('ShareReceiveMissDialog pull progress announcement', () => {
  test('starting a pull is announced to assistive tech', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    const status = screen.getByTestId('share-receive-miss-pull-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    await waitFor(() => {
      expect(screen.getByTestId('share-receive-miss-pull-status').textContent).toBe(
        'Pulling the latest changes',
      );
    });
    expect(screen.getByTestId('share-receive-miss-pull-now').getAttribute('aria-busy')).toBe(
      'true',
    );
  });
});
