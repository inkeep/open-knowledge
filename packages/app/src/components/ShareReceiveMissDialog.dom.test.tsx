/**
 * Behavioral tests for `ShareReceiveMissDialog` — the primary (no-navigation)
 * miss surface. Self-gates on `missDialogStore`; the verdict fetch reads a
 * stubbed `window.okDesktop`. The load-bearing property: acting on the dialog
 * navigates via the hash but the dialog itself NEVER sets the hash to the dead
 * path, so no phantom tab is opened.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */

import type { ShareTargetStatusResponse } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { missDialogStore } from '@/lib/share/miss-dialog-store';
import { pendingReceiveNavStore } from '@/lib/share/pending-receive-nav-store';

// The recovery flows write sync config through the project-local binding: Enable
// auto-sync via useSyncEnabledWriter (legacy boolean + mode), the post-pull
// follow offer via useSyncModeWriter (mode + a cleared legacy flag). Mock the
// binding so both guarded flows run without a live config context, and capture
// the whole `autoSync` patch so either shape is assertable. Mocked before the
// dynamic import below.
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

// The changed-locally cell picks its CTA off the live sync status (Enable
// auto-sync when off, Sync now when on). Reactive mock so a test can land a
// sync (lastSyncUtc advance) and observe the re-probe.
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

/**
 * Status of a sync-off receiver whose engine carries the pull-outcome contract —
 * the shape that makes the behind cells' pull CTA actionable. `makeSyncStatus`
 * deliberately omits `lastPullUtc` so the default is the version-skew case.
 */
function pullableSyncStatus(partial: Partial<GitSyncStatus> = {}): GitSyncStatus {
  return makeSyncStatus({
    syncEnabled: false,
    state: 'disabled',
    lastPullUtc: 'p0',
    lastPullOutcome: null,
    ...partial,
  });
}

/**
 * A receiver who is already syncing on a pull-capable engine — the shape where a
 * landed pull resolves the miss directly, with no follow offer to answer first.
 */
function syncingPullableStatus(partial: Partial<GitSyncStatus> = {}): GitSyncStatus {
  return pullableSyncStatus({ syncEnabled: true, state: 'idle', ...partial });
}

const { ShareReceiveMissDialog } = await import('./ShareReceiveMissDialog');
// Same module instance the dialog renders, so the once-per-session follow-offer
// latch resets between tests instead of the first offer suppressing the rest.
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

/**
 * The consent dialog a recovery CTA opens over the miss dialog — the other
 * `role=dialog`, since the miss dialog is the one carrying the testid.
 */
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
    // Titled by the target basename so the receiver sees what they tried to open.
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
    // Sync is OFF — the enable CTA renders, never the Sync-now one.
    expect(screen.queryByTestId('share-receive-miss-sync-now')).toBeNull();

    // Open the guarded confirm, then confirm inside it. Confirming enables in
    // place AND dismisses the miss dialog (regression guard: the dialog must
    // dismiss on confirm).
    fireEvent.click(screen.getByTestId('share-receive-miss-enable-sync'));
    fireEvent.click(within(openConsentDialog()).getByRole('button', { name: 'Enable auto-sync' }));

    expect(autoSyncWrites).toEqual([{ mode: 'full', enabled: true }]);
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
  });

  test('changed-locally with auto-sync ON offers Sync now; a landed sync re-probes to the honest verdict', async () => {
    // First probe says changed-locally; after the push lands the local rename is
    // on the branch, so the re-probe reports renamed with the redirect target.
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
    // Sync is already ON — offering to enable it would be nonsense.
    expect(screen.queryByTestId('share-receive-miss-enable-sync')).toBeNull();

    // The in-flight announcement region exists (empty) before the click.
    expect(screen.getByTestId('share-receive-miss-sync-status').textContent).toBe('');

    fireEvent.click(screen.getByTestId('share-receive-miss-sync-now'));
    expect(syncTriggers).toEqual(['sync']);
    // In-flight until the push lands.
    expect((screen.getByTestId('share-receive-miss-sync-now') as HTMLButtonElement).disabled).toBe(
      true,
    );
    // ...and announced, not just a silent label swap on a disabled button.
    const syncStatusRegion = screen.getByTestId('share-receive-miss-sync-status');
    expect(syncStatusRegion.getAttribute('role')).toBe('status');
    expect(syncStatusRegion.textContent).toBe('Syncing your changes');

    // The push lands (lastSyncUtc advances over the status channel) → the
    // verdict is re-probed → the dialog pivots to the renamed cell.
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

    // The rejected trigger drops the in-flight state so the user can retry —
    // no CC1 status update will ever follow a trigger that never landed.
    await waitFor(() => {
      expect(
        (screen.getByTestId('share-receive-miss-sync-now') as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    // No re-probe happened: the verdict is unchanged.
    expect(dialog.getAttribute('data-verdict')).toBe('changed-locally');
  });

  test('changed-locally with an unknown sync state renders neither sync CTA', async () => {
    installBridge(stubVerdict({ verdict: 'changed-locally' }));
    // syncStatus stays null (no status response yet / unreachable).
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

    // Navigated to the folder, NOT to the missing doc (no phantom tab).
    expect(window.location.hash).toBe('#/notes/');
    // Dialog dismissed itself.
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
  });

  test('accepting the rename navigates to the redirect, arms the backstop, and dismisses', async () => {
    installBridge(stubVerdict({ verdict: 'renamed', renamedTo: 'knowledge/new-plan.md' }));
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-open-renamed'));

    expect(window.location.hash).toBe('#/knowledge/new-plan.md');
    // Backstop armed so a locally-behind redirect target still lands on the miss
    // surface rather than create-mode.
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
    // The button replaces the manual instruction it used to give.
    expect(dialog.textContent).toContain('is behind');
    expect(dialog.textContent).not.toContain('then open the link again');
    // The escape hatch stays available alongside it.
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
    // syncStatus stays null (no response yet / server unreachable).
    const dialog = await renderArmed();

    expect(screen.queryByTestId('share-receive-miss-pull-now')).toBeNull();
    // Falls back to exactly the guidance the cell gave before the CTA existed.
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
    // A status payload with no `lastPullUtc` key at all: an older engine that
    // would never report a pull back, so the CTA would spin forever.
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
    // Still open — nothing has landed yet.
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
    // Backstop armed: if the target is somehow still absent, the panel renders
    // the honest verdict rather than a create-mode fork.
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
    // The fast-forward landed before the per-doc conflict was recorded, so the
    // target exists locally and the locked-editor resolver owns the signal.
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'conflict' }));

    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
    expect(window.location.hash).toBe('#/notes/plan.md');
    // The dialog dismissed on navigation — no failure line was ever shown, and
    // nothing remains mounted to claim one.
    expect(screen.queryByTestId('share-receive-miss-pull-error')).toBeNull();
  });

  test('a refused pull explains the engine is busy and stays retriable', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    fireEvent.click(screen.getByTestId('share-receive-miss-pull-now'));
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'refused' }));

    // The alert region is pre-mounted; the failure POPULATES it (inserting an
    // already-full alert is skipped by some screen readers).
    await waitFor(() => {
      expect(screen.getByTestId('share-receive-miss-pull-error').textContent).toContain(
        'Another sync operation is in progress',
      );
    });
    // The dialog holds, and the button is live again for a retry.
    expect(missDialogStore.getSnapshot()).not.toBeNull();
    const button = screen.getByTestId('share-receive-miss-pull-now') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    // Retrying fires a second pull and clears the stale failure text.
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

    // No status update will ever follow, so the surface must report it itself
    // rather than spin.
    await waitFor(() => {
      expect(screen.getByTestId('share-receive-miss-pull-error').textContent).toContain(
        'Check your connection',
      );
    });
    expect((screen.getByTestId('share-receive-miss-pull-now') as HTMLButtonElement).disabled).toBe(
      false,
    );

    // A background pull completing AFTER the click already failed must not be
    // read as the click's result: no navigation, no follow offer, and the
    // failure explanation stays put. (The watcher only listens while pending.)
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

    // A commit/push advancing lastSyncUtc is not this pull completing.
    setSyncStatus(syncingPullableStatus({ lastSyncUtc: 's1' }));
    await waitFor(() => {
      expect(
        (screen.getByTestId('share-receive-miss-pull-now') as HTMLButtonElement).textContent,
      ).toContain('Pulling');
    });
    expect(missDialogStore.getSnapshot()).not.toBeNull();

    // An up-to-date pull leaves lastSyncUtc alone; only lastPullUtc moves.
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

    // The offer arrives at the moment the pull proved its worth, and it holds
    // the navigation — the receiver answers before the doc opens.
    const consent = await waitFor(() => openConsentDialog());
    expect(window.location.hash).toBe('');
    expect(autoSyncWrites).toEqual([]);

    fireEvent.click(within(consent).getByRole('button', { name: 'Enable Follow' }));

    // Follow mode lands, and the legacy boolean is cleared so an older app can't
    // read the project as full-sync and start pushing this receiver's copy.
    expect(autoSyncWrites).toEqual([{ mode: 'follow', enabled: null }]);
    // Nothing left to fetch — the content arrived with the pull just answered.
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
    // up-to-date is the common outcome when the remote was already current — the
    // offer must still stand for a sync-off receiver, not just after `succeeded`.
    setSyncStatus(pullableSyncStatus({ lastPullUtc: 'p1', lastPullOutcome: 'up-to-date' }));

    const consent = await waitFor(() => openConsentDialog());
    expect(window.location.hash).toBe('');

    // Declining resolves the flow: no write, and the target still opens.
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

    // One primary action and the escape hatch — the offer is not a button here.
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

    // Saying no costs nothing: no write, and the doc still opens.
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
    fireEvent.click(within(consent).getByRole('button', { name: 'Enable Follow' }));

    // The failed write raises its own toast; it must not cost the receiver the
    // document the pull already fetched for them.
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

    // Dismissing without an answer is the proof: nothing was asked.
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
    // The failure line owns the surface — no consent gate over the top of it.
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

    // A second miss in the same session: they already said no once, so this pull
    // resolves without asking again.
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

    // Every other follow-enable surface warns about unpushed commits; a
    // receiver consenting from this one deserves the same honesty.
    const consent = await waitFor(() => openConsentDialog());
    expect(within(consent).getByText(/3 changes you haven't shared/)).toBeTruthy();
  });
});

describe('ShareReceiveMissDialog pull progress announcement', () => {
  test('starting a pull is announced to assistive tech', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    setSyncStatus(pullableSyncStatus());
    await renderArmed();

    // The region exists before the click and is empty — populating an
    // already-mounted live region is what screen readers reliably announce.
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
