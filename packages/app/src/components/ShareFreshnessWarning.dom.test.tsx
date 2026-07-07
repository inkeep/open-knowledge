/**
 * Matrix coverage for the share popover's freshness warning row. Prop-driven
 * (the `GitSyncStatus` is passed directly, not mocked through the hook), so each
 * cell of freshness × syncEnabled × pushPermission is exercised in isolation.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';

// The Sync now CTA fires a real fetch through `triggerSync`; stub it so the
// click is observable without a network dependency (the landed transition is
// driven by re-rendering with an updated status, not by this call resolving).
// A mutable impl lets one test drive a rejected trigger (offline / server down).
let triggerSyncImpl: () => Promise<void> = () => Promise.resolve();
mock.module('@/lib/trigger-sync', () => ({ triggerSync: () => triggerSyncImpl() }));

// "Enable auto-sync" enables in place via the project-local config binding
// (through useSyncEnabledWriter). Capture the writes so a test can assert the
// off → on transition instead of a navigation.
let autoSyncWrites: boolean[] = [];
mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalBinding: {
      patch: (value: { autoSync?: { enabled?: boolean } }) => {
        if (value.autoSync?.enabled !== undefined) autoSyncWrites.push(value.autoSync.enabled);
        return { ok: true };
      },
    },
  }),
}));

const { ShareFreshnessWarning } = await import('./ShareFreshnessWarning');

function makeStatus(overrides: Partial<GitSyncStatus> = {}): GitSyncStatus {
  return {
    state: 'idle',
    lastSyncUtc: null,
    lastFetchUtc: null,
    ahead: 0,
    behind: 0,
    conflictCount: 0,
    hasRemote: true,
    syncEnabled: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  triggerSyncImpl = () => Promise.resolve();
  autoSyncWrites = [];
});

describe('ShareFreshnessWarning', () => {
  test('renders no row when freshness is current', () => {
    render(<ShareFreshnessWarning freshness="current" status={makeStatus()} kind="doc" />);
    expect(screen.queryByTestId('share-freshness-row')).toBeNull();
  });

  test('renders no row when freshness is omitted (fail-open)', () => {
    render(<ShareFreshnessWarning freshness={undefined} status={makeStatus()} kind="doc" />);
    expect(screen.queryByTestId('share-freshness-row')).toBeNull();
  });

  test('absent + sync off: strong dead-link warning, icon + text (not color-only)', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: false })}
        kind="doc"
      />,
    );
    const row = screen.getByTestId('share-freshness-row');
    expect(row.textContent).toContain("This doc isn't on GitHub yet");
    expect(row.textContent).toContain("won't work until it's pushed");
    // A rendered icon is the non-color cue that makes the warning perceivable
    // without relying on the tint alone.
    expect(row.querySelector('svg')).not.toBeNull();
  });

  test('stale + sync off: soft unpushed-changes note', () => {
    render(
      <ShareFreshnessWarning
        freshness="stale"
        status={makeStatus({ syncEnabled: false })}
        kind="doc"
      />,
    );
    expect(screen.getByTestId('share-freshness-row').textContent).toContain(
      'This doc has unpushed changes',
    );
  });

  test('stale + sync on: ratified silent cell renders no row', () => {
    render(
      <ShareFreshnessWarning
        freshness="stale"
        status={makeStatus({ syncEnabled: true })}
        kind="doc"
      />,
    );
    expect(screen.queryByTestId('share-freshness-row')).toBeNull();
  });

  test('absent + sync on: soft not-synced-yet note', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: true })}
        kind="doc"
      />,
    );
    expect(screen.getByTestId('share-freshness-row').textContent).toContain(
      "This doc hasn't synced to GitHub yet",
    );
  });

  test('pushPermission denied: keeps the fact line and adds the no-write-access line', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({
          syncEnabled: false,
          pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
        })}
        kind="doc"
      />,
    );
    const text = screen.getByTestId('share-freshness-row').textContent ?? '';
    expect(text).toContain("This doc isn't on GitHub yet");
    expect(text).toContain("don't have write access to this repo");
  });

  test('active push error: keeps the fact line and defers to the sync status', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: false, pushError: 'push rejected (non-fast-forward)' })}
        kind="doc"
      />,
    );
    const text = screen.getByTestId('share-freshness-row').textContent ?? '';
    expect(text).toContain("This doc isn't on GitHub yet");
    expect(text).toContain('Sync is failing');
  });

  test('folder kind substitutes "folder" in the fact line', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: false })}
        kind="folder"
      />,
    );
    expect(screen.getByTestId('share-freshness-row').textContent).toContain(
      "This folder isn't on GitHub yet",
    );
  });
});

describe('ShareFreshnessWarning — recovery CTAs (FR4/FR5)', () => {
  test('absent + sync off offers Enable auto-sync and How to push manually (git-scm)', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: false })}
        kind="doc"
      />,
    );
    expect(screen.getByRole('button', { name: 'Enable auto-sync' })).not.toBeNull();
    const link = screen.getByRole('link', { name: /How to push manually/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://git-scm.com/docs/git-push');
  });

  test('Enable auto-sync opens the guarded confirm and enables in place (no navigation)', () => {
    window.location.hash = '';
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: false })}
        kind="doc"
      />,
    );
    // The row CTA opens the off → on confirmation gate rather than navigating
    // the sender away to the settings surface.
    fireEvent.click(screen.getByRole('button', { name: 'Enable auto-sync' }));
    const dialog = screen.getByRole('dialog');
    expect(window.location.hash).toBe('');
    expect(autoSyncWrites).toEqual([]); // nothing written until the user confirms

    // Confirming the gate enables auto-sync in place via the project-local
    // config binding.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable auto-sync' }));
    expect(autoSyncWrites).toEqual([true]);
  });

  test('absent + sync on offers Sync now (not the push-manually CTAs)', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: true, state: 'idle' })}
        kind="doc"
      />,
    );
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable auto-sync' })).toBeNull();
    expect(screen.queryByRole('link', { name: /How to push manually/ })).toBeNull();
  });

  test('Sync now goes in-flight, then self-clears to Synced on a completed sync', () => {
    const { rerender } = render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: true, state: 'idle', lastSyncUtc: null })}
        kind="doc"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(screen.getByRole('button', { name: /Syncing/ })).not.toBeNull();

    // A completed sync bumps lastSyncUtc — the "push landed" signal.
    rerender(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({
          syncEnabled: true,
          state: 'idle',
          lastSyncUtc: '2026-07-02T12:00:00Z',
        })}
        kind="doc"
      />,
    );
    expect(screen.getByTestId('share-freshness-row').textContent).toContain(
      'Synced. The link is up to date.',
    );
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  test('Sync now reverts from in-flight when the push errors, surfacing the failure line', () => {
    const { rerender } = render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: true, state: 'idle', lastSyncUtc: null })}
        kind="doc"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    rerender(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: true, state: 'idle', pushError: 'push rejected' })}
        kind="doc"
      />,
    );
    const text = screen.getByTestId('share-freshness-row').textContent ?? '';
    expect(text).toContain('Sync is failing');
    expect(screen.queryByRole('button', { name: /Syncing/ })).toBeNull();
  });

  test('Sync now reverts to actionable when the trigger itself fails, never a stuck spinner', async () => {
    // The trigger never lands (offline / server down): no CC1 status update
    // follows, so without recovery the button would spin "Syncing" forever.
    triggerSyncImpl = () => Promise.reject(new Error('offline'));
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: true, state: 'idle', lastSyncUtc: null })}
        kind="doc"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(screen.getByRole('button', { name: /Syncing/ })).not.toBeNull();

    // The rejected trigger drops back to the actionable Sync now button.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync now' })).not.toBeNull();
    });
    expect(screen.queryByRole('button', { name: /Syncing/ })).toBeNull();
  });

  test('Sync now is hidden when the engine is blocked (conflict), leaving the fact line', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({ syncEnabled: true, state: 'conflict', conflictCount: 1 })}
        kind="doc"
      />,
    );
    expect(screen.getByTestId('share-freshness-row').textContent).toContain(
      "This doc hasn't synced to GitHub yet",
    );
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  test('a denied push probe shows no recovery CTAs', () => {
    render(
      <ShareFreshnessWarning
        freshness="absent"
        status={makeStatus({
          syncEnabled: false,
          pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
        })}
        kind="doc"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Enable auto-sync' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(screen.queryByRole('link', { name: /How to push manually/ })).toBeNull();
  });
});
