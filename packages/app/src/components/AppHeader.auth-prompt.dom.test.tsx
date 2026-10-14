import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppHeader } from '@/components/AppHeader';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { authPromptStore } from '@/lib/auth-prompt-store';

const sync = vi.hoisted(() => ({ status: null as GitSyncStatus | null }));

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'docs/notes',
    activeTarget: { kind: 'doc' },
    activeProvider: null,
  }),
}));

vi.mock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({ status: sync.status, fetchError: null }),
  useGitSyncStatus: () => sync.status,
}));

vi.mock('@/hooks/use-conflicts', () => ({
  useConflicts: () => ({ conflicts: [], loading: false, error: null, refresh: () => {} }),
}));

vi.mock('@/hooks/use-git-worktree-status', () => ({
  useGitWorktreeStatus: () => ({
    status: null,
    loading: false,
    unreadable: true,
    stale: false,
    lastReadAt: null,
  }),
}));

vi.mock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalConfig: { autoSync: { enabled: false } },
    projectLocalSynced: true,
    projectLocalBinding: { patch: () => ({ ok: true as const }) },
  }),
}));

vi.mock('@/presence/PresenceBar', () => ({
  PresenceBar: () => null,
}));

vi.mock('@/presence/use-sync-toasts', () => ({
  useSyncToasts: () => {},
}));

vi.mock('@/components/HelpPopover', () => ({
  HelpPopover: () => null,
}));

vi.mock('@/components/PublishToGitHubDialog', () => ({
  PublishToGitHubDialog: () => null,
}));

const connectedStatus: GitSyncStatus = {
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

async function openSyncPopover() {
  render(<AppHeader onOpenSearch={() => {}} />, { wrapper: TooltipProvider });
  await userEvent.click(screen.getByRole('button', { name: /^Sync status:/ }));
}

afterEach(() => {
  cleanup();
  authPromptStore.clear();
  sync.status = null;
});

describe('AppHeader sync prompts', () => {
  test('Sign in from the header sync popover asks for the sign-in step', async () => {
    sync.status = {
      ...connectedStatus,
      state: 'auth-error',
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-401',
    };
    await openSyncPopover();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(authPromptStore.getSnapshot()).toBe('auth');
  });

  test('Set identity from the header sync popover asks for the identity step', async () => {
    sync.status = { ...connectedStatus, identityUnresolved: true };
    await openSyncPopover();

    await userEvent.click(await screen.findByRole('button', { name: 'Set identity' }));

    expect(authPromptStore.getSnapshot()).toBe('identity');
  });
});
