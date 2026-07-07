/**
 * Behavioral tests for `ShareReceiveMissDialog` — the primary (no-navigation)
 * miss surface. Self-gates on `missDialogStore`; the verdict fetch reads a
 * stubbed `window.okDesktop`. The load-bearing property: acting on the dialog
 * navigates via the hash but the dialog itself NEVER sets the hash to the dead
 * path, so no phantom tab is opened.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ShareTargetStatusResponse } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { missDialogStore } from '@/lib/share/miss-dialog-store';
import { pendingReceiveNavStore } from '@/lib/share/pending-receive-nav-store';

// The changed-locally cell's Enable auto-sync CTA reaches useSyncEnabledWriter →
// useConfigContext; mock the binding so the guarded flow runs without a live
// config context, and capture writes. Mocked before the dynamic import below.
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

const { ShareReceiveMissDialog } = await import('./ShareReceiveMissDialog');

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
});
afterEach(() => {
  cleanup();
  missDialogStore.dismiss();
  pendingReceiveNavStore.clear();
  Reflect.deleteProperty(window, 'okDesktop');
  autoSyncWrites = [];
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
    const dialog = await renderArmed();

    expect(dialog.getAttribute('data-verdict')).toBe('changed-locally');
    expect(dialog.textContent).toContain('has been moved, renamed, or deleted');

    // Open the guarded confirm, then confirm inside it (the confirm dialog is the
    // OTHER role=dialog — the miss dialog carries the testid). Confirming enables
    // in place AND dismisses the miss dialog (the reported gap: it used to stay).
    fireEvent.click(screen.getByTestId('share-receive-miss-enable-sync'));
    const confirm = screen
      .getAllByRole('dialog')
      .find((d) => d.getAttribute('data-testid') !== 'share-receive-miss-dialog');
    if (!confirm) throw new Error('confirm dialog not found');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Enable auto-sync' }));

    expect(autoSyncWrites).toEqual([true]);
    await waitFor(() => {
      expect(missDialogStore.getSnapshot()).toBeNull();
    });
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
