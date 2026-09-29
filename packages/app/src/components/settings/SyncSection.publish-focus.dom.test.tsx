import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SyncSection } from './SyncSection';

const syncStatus = vi.hoisted(() => ({ hasRemote: false }));

vi.mock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => ({ state: 'dormant', conflictCount: 0, hasRemote: syncStatus.hasRemote }),
  useGitSyncStatusDetailed: () => ({
    status: { state: 'dormant', conflictCount: 0, hasRemote: syncStatus.hasRemote },
    fetchError: null,
  }),
}));

vi.mock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectConfig: null,
    projectLocalConfig: null,
    projectLocalSynced: true,
    projectSynced: true,
  }),
}));

vi.mock('@/hooks/use-enable-sync-with-confirm', () => ({
  useSyncModeWriter: () => null,
  useSyncDefaultWriter: () => null,
  useSyncIntervalWriter: () => null,
  useSyncModeSelection: () => ({
    confirmOpen: false,
    setConfirmOpen: () => {},
    pendingMode: null,
    onModeSelect: () => {},
    onConfirm: () => {},
  }),
}));

vi.mock('@/lib/use-settings-route', () => ({ consumeSyncAdvancedIntent: () => false }));

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeDocName: null }),
}));

vi.mock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/projects/field-notes' }),
}));

vi.mock('@/lib/share/publish-wizard', async () => ({
  ...(await vi.importActual<typeof import('@/lib/share/publish-wizard')>(
    '@/lib/share/publish-wizard',
  )),
  fetchPublishOwners: async () => ({ ok: true, owners: [{ kind: 'user', login: 'alice' }] }),
  fetchPublishNameCheck: async () => ({ ok: true, available: true }),
  submitPublishRequest: async () => ({ ok: true, ownerLogin: 'alice', repoName: 'field-notes' }),
}));

afterEach(() => {
  syncStatus.hasRemote = false;
  cleanup();
});

test('closing the Publish to GitHub dialog focuses the "Set up syncing" button that opened it', async () => {
  render(<SyncSection />, { wrapper: TooltipProvider });

  const setUp = screen.getByTestId('settings-sync-setup');
  await userEvent.click(setUp);
  await screen.findByRole('dialog');

  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  expect(document.activeElement).toBe(setUp);
});

test('successful publishing keeps the success dialog open and returns focus to Sync after its opener disappears', async () => {
  const view = render(<SyncSection />, { wrapper: TooltipProvider });

  await userEvent.click(screen.getByTestId('settings-sync-setup'));
  await screen.findByRole('dialog');
  await waitFor(
    () =>
      expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    { timeout: 1500 },
  );
  await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
  await screen.findByRole('button', { name: 'Done' });

  syncStatus.hasRemote = true;
  view.rerender(<SyncSection />);
  expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(screen.getByTestId('settings-sync-section'));
});
