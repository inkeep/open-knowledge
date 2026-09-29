import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorHeader } from '@/components/EditorHeader';
import { TooltipProvider } from '@/components/ui/tooltip';
import { captureResizeObserver, mockHeaderMetrics } from './EditorHeader.layout.test-helper';

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'docs/notes',
    activeTarget: { kind: 'doc' },
    activeProvider: null,
    panes: [{ id: 'pane-0' }],
  }),
}));

vi.mock('@/lib/single-file-mode', () => ({ useSingleFileMode: () => false }));

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded' }),
  SidebarTrigger: (props: ComponentProps<'button'>) => (
    <button type="button" data-testid="sidebar-trigger" {...props}>
      sidebar
    </button>
  ),
}));

vi.mock('@/components/AppMenubar', () => ({ AppMenubar: () => null }));

vi.mock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({
    status: { state: 'dormant', conflictCount: 0, hasRemote: false },
    fetchError: null,
  }),
  useGitSyncStatus: () => ({ state: 'dormant', conflictCount: 0, hasRemote: false }),
}));

vi.mock('@/presence/use-sync-toasts', () => ({ useSyncToasts: () => {} }));

vi.mock('@/presence/PresenceBar', () => ({
  PresenceBar: () => <div data-testid="presence-bar" />,
}));

vi.mock('@/components/SyncStatusBadge', async () => ({
  ...(await vi.importActual<typeof import('@/components/SyncStatusBadge')>(
    '@/components/SyncStatusBadge',
  )),
  SyncStatusBadge: () => <div data-testid="sync-status-badge" />,
}));

vi.mock('@/components/BetaBadge', () => ({ BetaBadge: () => null }));
vi.mock('@/components/InstanceBadge', () => ({ InstanceBadge: () => null }));
vi.mock('@/components/SettingsButton', () => ({
  SettingsButton: () => <div data-testid="settings-button" />,
}));
vi.mock('@/components/HelpPopover', () => ({
  HelpPopover: () => <div data-testid="help-popover" />,
}));

vi.mock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/projects/field-notes' }),
}));

vi.mock('@/lib/share/publish-wizard', async () => ({
  ...(await vi.importActual<typeof import('@/lib/share/publish-wizard')>(
    '@/lib/share/publish-wizard',
  )),
  fetchPublishOwners: () => new Promise(() => {}),
  fetchPublishNameCheck: () => new Promise(() => {}),
}));

const CRAMPED = { header: 107, leading: 57, trailing: 218, collapsedTrailing: 44 };
const ROOMY = { header: 1_280, leading: 57, trailing: 218 };

let metrics: typeof CRAMPED | typeof ROOMY = ROOMY;
let resizeObserver: ReturnType<typeof captureResizeObserver> | null = null;

function installLayout() {
  mockHeaderMetrics(() => metrics);
  resizeObserver = captureResizeObserver();
}

function relayout(next: typeof CRAMPED | typeof ROOMY) {
  metrics = next;
  resizeObserver?.flush();
}

function renderHeader() {
  return render(
    <EditorHeader onOpenSearch={() => {}}>
      <div>tabs</div>
    </EditorHeader>,
    { wrapper: TooltipProvider },
  );
}

function trailingGroup(): HTMLElement {
  return document.querySelector('[data-editor-header-actions]') as HTMLElement;
}

async function closeDialogWithEscape() {
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  metrics = ROOMY;
  resizeObserver?.restore();
  resizeObserver = null;
});

describe('EditorHeader Publish to GitHub dialog focus return', () => {
  test('closing the dialog opened from the inline Share button focuses that Share button', async () => {
    installLayout();
    renderHeader();

    const share = await within(trailingGroup()).findByRole('button', { name: 'Share doc' });
    await userEvent.click(share);
    await screen.findByRole('dialog');

    await closeDialogWithEscape();

    expect(document.activeElement).toBe(share);
  });

  test('when the actions fold away while the dialog is open, closing it focuses "More actions"', async () => {
    installLayout();
    renderHeader();

    await userEvent.click(
      await within(trailingGroup()).findByRole('button', { name: 'Share doc' }),
    );
    await screen.findByRole('dialog');

    relayout(CRAMPED);
    const trigger = await screen.findByTestId('header-overflow-actions-trigger');
    expect(screen.queryByRole('button', { name: 'Share doc' })).toBeNull();

    await closeDialogWithEscape();

    expect(document.activeElement).toBe(trigger);
  });

  test('closing the dialog opened from Share inside a "More actions" panel that has since closed focuses "More actions"', async () => {
    metrics = CRAMPED;
    installLayout();
    renderHeader();

    const trigger = await screen.findByTestId('header-overflow-actions-trigger');
    await userEvent.click(trigger);
    const panel = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-editor-header-overflow-actions]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(panel).getByRole('button', { name: 'Share doc' }));
    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(document.querySelector('[data-editor-header-overflow-actions]')).toBeNull(),
    );

    await closeDialogWithEscape();

    expect(document.activeElement).toBe(trigger);
  });
});
