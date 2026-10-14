import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppHeader } from '@/components/AppHeader';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfigContext } from '@/lib/config-context';
import { configContextWithTerminal, TERMINAL_SETTING_UNSET } from '@/test-utils/config-context';

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'docs/notes',
    activeTarget: { kind: 'doc' },
    activeProvider: null,
  }),
}));

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

const CRAMPED = { header: 470, leading: 220, trailing: 420, collapsedTrailing: 44 };
const ROOMY = { header: 1_280, leading: 220, trailing: 420 };

let metrics: typeof CRAMPED | typeof ROOMY = ROOMY;
let resizeCallbacks: ResizeObserverCallback[] = [];

function installLayout() {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-app-header')) return metrics.header;
    if (this.hasAttribute('data-app-header-leading')) return metrics.leading;
    if (this.hasAttribute('data-app-header-trailing')) {
      const collapsed =
        this.querySelector('[data-testid="header-overflow-actions-trigger"]') !== null;
      return collapsed && 'collapsedTrailing' in metrics
        ? metrics.collapsedTrailing
        : metrics.trailing;
    }
    return 0;
  });
  class CapturingResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', CapturingResizeObserver);
}

function relayout(next: typeof CRAMPED | typeof ROOMY) {
  metrics = next;
  for (const callback of resizeCallbacks) {
    act(() => callback([], {} as ResizeObserver));
  }
}

function HeaderProviders({ children }: { children: ReactNode }) {
  return (
    <ConfigContext value={configContextWithTerminal(TERMINAL_SETTING_UNSET)}>
      <TooltipProvider>{children}</TooltipProvider>
    </ConfigContext>
  );
}

function renderHeader() {
  return render(<AppHeader onOpenSearch={() => {}} />, { wrapper: HeaderProviders });
}

function trailingGroup(): HTMLElement {
  return screen.getByRole('banner').querySelector('[data-app-header-trailing]') as HTMLElement;
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
  resizeCallbacks = [];
});

describe('AppHeader Publish to GitHub dialog focus return', () => {
  test('closing the dialog opened from the inline Share button focuses that Share button', async () => {
    installLayout();
    renderHeader();

    const share = within(trailingGroup()).getByRole('button', { name: 'Share doc' });
    await userEvent.click(share);
    await screen.findByRole('dialog');

    await closeDialogWithEscape();

    expect(document.activeElement).toBe(share);
  });

  test('when the actions fold away while the dialog is open, closing it focuses "More actions"', async () => {
    installLayout();
    renderHeader();

    await userEvent.click(within(trailingGroup()).getByRole('button', { name: 'Share doc' }));
    await screen.findByRole('dialog');

    relayout(CRAMPED);
    const trigger = screen.getByTestId('header-overflow-actions-trigger');
    expect(screen.queryByRole('button', { name: 'Share doc' })).toBeNull();

    await closeDialogWithEscape();

    expect(document.activeElement).toBe(trigger);
  });

  test('closing the dialog opened from Share inside a "More actions" panel that has since closed focuses "More actions"', async () => {
    metrics = CRAMPED;
    installLayout();
    renderHeader();

    const trigger = screen.getByTestId('header-overflow-actions-trigger');
    await userEvent.click(trigger);
    const panel = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-header-overflow-actions]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(panel).getByRole('button', { name: 'Share doc' }));
    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(document.querySelector('[data-header-overflow-actions]')).toBeNull(),
    );

    await closeDialogWithEscape();

    expect(document.activeElement).toBe(trigger);
  });
});
